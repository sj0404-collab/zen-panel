package eu.kanade.presentation.reader

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import eu.kanade.tachiyomi.data.ui.UiActionRegistry
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mihon.data.ui.UiActionSpec
import mihon.data.ui.UiPlacement

/**
 * OCR voice actions intentionally live outside the result card. The reader keeps
 * the recognized text uncluttered while both speech and voice selection remain
 * available next to the active OCR dialog.
 */
@Composable
fun OcrVoiceFloatingControls(
    enabled: Boolean,
    onSpeak: () -> Unit,
    onChooseVoice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Пользовательские действия реестра UiActions для карточки OCR.
    val context = LocalContext.current
    var userActions by remember { mutableStateOf<List<UiActionSpec>>(emptyList()) }
    LaunchedEffect(Unit) {
        userActions = withContext(Dispatchers.IO) {
            UiActionRegistry.list(context).filter { it.placement == UiPlacement.OCR_CARD }
        }
    }

    Column(modifier = modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ExtendedFloatingActionButton(
                onClick = { if (enabled) onSpeak() },
                icon = { Icon(Icons.Outlined.RecordVoiceOver, contentDescription = null) },
                containerColor = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                text = { Text("Голос") },
            )
            ExtendedFloatingActionButton(
                onClick = onChooseVoice,
                icon = { Icon(Icons.Outlined.Tune, contentDescription = null) },
                containerColor = MaterialTheme.colorScheme.secondaryContainer,
                contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                text = { Text("Выбрать голос") },
            )
        }
        // Свои действия — отдельной прокручиваемой строкой, чтобы длинный
        // список не уезжал за экран и не ломал основные кнопки озвучки.
        if (userActions.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .padding(top = 8.dp)
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                userActions.forEach { action ->
                    ExtendedFloatingActionButton(
                        onClick = { context.toast(UiActionRegistry.apply(context, action)) },
                        icon = { Icon(Icons.Outlined.Tune, contentDescription = null) },
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        text = { Text(action.title) },
                    )
                }
            }
        }
    }
}
