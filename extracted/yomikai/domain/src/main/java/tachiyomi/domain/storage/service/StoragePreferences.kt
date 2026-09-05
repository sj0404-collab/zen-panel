package tachiyomi.domain.storage.service

import tachiyomi.core.common.preference.Preference
import tachiyomi.core.common.preference.PreferenceStore
import tachiyomi.core.common.storage.FolderProvider

class StoragePreferences(
    folderProvider: FolderProvider,
    preferenceStore: PreferenceStore,
) {

    val baseStorageDirectory: Preference<String> = preferenceStore.getString(
        Preference.appStateKey("storage_dir"),
        folderProvider.path(),
    )

    /**
     * Сторонняя библиотека: неограниченный набор внешних папок (SAF tree URI),
     * добавленных пользователем из любых мест, включая Android/data.
     * Не смешивается с основным хранилищем приложения.
     */
    val externalLibraryRoots: Preference<Set<String>> = preferenceStore.getStringSet(
        Preference.appStateKey("external_library_roots"),
        emptySet(),
    )

    /** Активная категория сторонней библиотеки: URI папки или "" (все папки). */
    val externalLibraryActiveRoot: Preference<String> = preferenceStore.getString(
        Preference.appStateKey("external_library_active_root"),
        "",
    )
}
