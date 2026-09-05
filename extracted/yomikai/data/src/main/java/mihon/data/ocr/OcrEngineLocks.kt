package mihon.data.ocr

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal class OcrEngineLocks {
    private val cyrillicMutex = Mutex()
    private val legacyMutex = Mutex()
    private val fastMutex = Mutex()
    private val glensMutex = Mutex()
    private val owOcrMutex = Mutex()
    private val openRouterMutex = Mutex()
    private val googleAiMutex = Mutex()
    private val zenFreeMutex = Mutex()
    private val detectionMutex = Mutex()

    suspend fun <T> withTextEngineLock(
        type: OcrRepositoryImpl.EngineType,
        block: suspend () -> T,
    ): T {
        return mutexFor(type).withLock {
            block()
        }
    }

    suspend fun <T> withDetectionLock(block: suspend () -> T): T {
        return detectionMutex.withLock {
            block()
        }
    }

    suspend fun <T> withAllLocks(block: suspend () -> T): T {
        return cyrillicMutex.withLock {
            legacyMutex.withLock {
                fastMutex.withLock {
                    glensMutex.withLock {
                        owOcrMutex.withLock {
                            openRouterMutex.withLock {
                                googleAiMutex.withLock {
                                    zenFreeMutex.withLock {
                                        detectionMutex.withLock {
                                            block()
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun mutexFor(type: OcrRepositoryImpl.EngineType): Mutex {
        return when (type) {
            OcrRepositoryImpl.EngineType.CYRILLIC -> cyrillicMutex
            OcrRepositoryImpl.EngineType.LEGACY -> legacyMutex
            OcrRepositoryImpl.EngineType.FAST -> fastMutex
            OcrRepositoryImpl.EngineType.GLENS -> glensMutex
            OcrRepositoryImpl.EngineType.OWOCR -> owOcrMutex
            OcrRepositoryImpl.EngineType.OPENROUTER -> openRouterMutex
            OcrRepositoryImpl.EngineType.GOOGLE -> googleAiMutex
            OcrRepositoryImpl.EngineType.ZEN_FREE -> zenFreeMutex
        }
    }
}
