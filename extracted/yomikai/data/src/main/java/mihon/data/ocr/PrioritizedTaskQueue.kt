package mihon.data.ocr

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Очередь задач сканирования с приоритетами и ОТМЕНОЙ по месту.
 *
 * Раньше задача выполнялась в воркере очереди: отмена вызова (стоп
 * авточтения) лишь бросала await у подписчика, а само распознавание
 * докручивалось до конца — пользователь видел «Processing OCR…» после
 * стопа. Теперь каждая задача идёт в отдельном Job, и отмена подписчика
 * снимает задачу из очереди или гасит выполняющийся Job.
 */
internal class PrioritizedTaskQueue(
    private val scope: CoroutineScope,
    private val onIdle: () -> Unit = {},
) {
    enum class Priority {
        HIGH,
        NORMAL,
    }

    private class Holder {
        @Volatile
        var job: Job? = null

        @Volatile
        var cancelled: Boolean = false
    }

    private class Item(val holder: Holder, val task: suspend () -> Unit)

    private val mutex = Mutex()
    private val highPriorityTasks = ArrayDeque<Item>()
    private val normalPriorityTasks = ArrayDeque<Item>()

    private var activeTasks = 0
    private var workerJob: Job? = null

    suspend fun <T> submit(
        priority: Priority,
        block: suspend () -> T,
    ): T {
        val result = CompletableDeferred<T>()
        val holder = Holder()
        val item = Item(holder) {
            if (!holder.cancelled) {
                try {
                    result.complete(block())
                } catch (e: Throwable) {
                    if (!result.isCompleted) result.completeExceptionally(e)
                }
            }
        }

        mutex.withLock {
            when (priority) {
                Priority.HIGH -> highPriorityTasks.addLast(item)
                Priority.NORMAL -> normalPriorityTasks.addLast(item)
            }
            if (workerJob?.isActive != true) {
                workerJob = scope.launch { processQueue() }
            }
        }

        try {
            return result.await()
        } finally {
            // Стоп подписчика = стоп задачи: снимаем из очереди или гасим Job.
            holder.cancelled = true
            mutex.withLock {
                highPriorityTasks.remove(item)
                normalPriorityTasks.remove(item)
            }
            holder.job?.cancel()
        }
    }

    suspend fun isIdle(): Boolean {
        return mutex.withLock {
            activeTasks == 0 && highPriorityTasks.isEmpty() && normalPriorityTasks.isEmpty()
        }
    }

    private suspend fun processQueue() {
        while (true) {
            val item = mutex.withLock {
                val nextTask = highPriorityTasks.removeFirstOrNull()
                    ?: normalPriorityTasks.removeFirstOrNull()

                if (nextTask == null) {
                    workerJob = null
                    null
                } else {
                    activeTasks++
                    nextTask
                }
            } ?: break

            val job = scope.launch { item.task() }
            item.holder.job = job
            job.join()
            val becameIdle = mutex.withLock {
                activeTasks--
                activeTasks == 0 && highPriorityTasks.isEmpty() && normalPriorityTasks.isEmpty()
            }
            if (becameIdle) {
                onIdle()
            }
        }
    }
}
