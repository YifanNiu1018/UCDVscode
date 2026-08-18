import getConfigurationServiceOverride, {
  IStoredWorkspace,
  initUserConfiguration
} from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride, {
  initUserKeybindings
} from '@codingame/monaco-vscode-keybindings-service-override'
import {
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
  createIndexedDBProviders,
  registerFileSystemOverlay
} from '@codingame/monaco-vscode-files-service-override'
import * as monaco from 'monaco-editor'
import {
  IWorkbenchConstructionOptions,
  LogLevel,
  IEditorOverrideServices,
  IWorkspace
} from '@codingame/monaco-vscode-api'
import * as vscode from 'vscode'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getNotificationServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getSecretStorageServiceOverride from '@codingame/monaco-vscode-secret-storage-service-override'
import getAuthenticationServiceOverride from '@codingame/monaco-vscode-authentication-service-override'
import getScmServiceOverride from '@codingame/monaco-vscode-scm-service-override'
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'
import getBannerServiceOverride from '@codingame/monaco-vscode-view-banner-service-override'
import getStatusBarServiceOverride from '@codingame/monaco-vscode-view-status-bar-service-override'
import getTitleBarServiceOverride from '@codingame/monaco-vscode-view-title-bar-service-override'
import getDebugServiceOverride from '@codingame/monaco-vscode-debug-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getSnippetServiceOverride from '@codingame/monaco-vscode-snippets-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getAccessibilityServiceOverride from '@codingame/monaco-vscode-accessibility-service-override'
import getLanguageDetectionWorkerServiceOverride from '@codingame/monaco-vscode-language-detection-worker-service-override'
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getRemoteAgentServiceOverride from '@codingame/monaco-vscode-remote-agent-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
import getWorkspaceTrustOverride from '@codingame/monaco-vscode-workspace-trust-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import getTestingServiceOverride from '@codingame/monaco-vscode-testing-service-override'
import getNotebookServiceOverride from '@codingame/monaco-vscode-notebook-service-override'
import getWelcomeServiceOverride from '@codingame/monaco-vscode-welcome-service-override'
import getWalkThroughServiceOverride from '@codingame/monaco-vscode-walkthrough-service-override'
import getUserDataSyncServiceOverride from '@codingame/monaco-vscode-user-data-sync-service-override'
import getUserDataProfileServiceOverride from '@codingame/monaco-vscode-user-data-profile-service-override'
import getTaskServiceOverride from '@codingame/monaco-vscode-task-service-override'
import getOutlineServiceOverride from '@codingame/monaco-vscode-outline-service-override'
import getTimelineServiceOverride from '@codingame/monaco-vscode-timeline-service-override'
import getCommentsServiceOverride from '@codingame/monaco-vscode-comments-service-override'
import getEditSessionsServiceOverride from '@codingame/monaco-vscode-edit-sessions-service-override'
import getEmmetServiceOverride from '@codingame/monaco-vscode-emmet-service-override'
import getInteractiveServiceOverride from '@codingame/monaco-vscode-interactive-service-override'
import getIssueServiceOverride from '@codingame/monaco-vscode-issue-service-override'
import getMultiDiffEditorServiceOverride from '@codingame/monaco-vscode-multi-diff-editor-service-override'
import getPerformanceServiceOverride from '@codingame/monaco-vscode-performance-service-override'
import getRelauncherServiceOverride from '@codingame/monaco-vscode-relauncher-service-override'
import getShareServiceOverride from '@codingame/monaco-vscode-share-service-override'
import getSurveyServiceOverride from '@codingame/monaco-vscode-survey-service-override'
import getUpdateServiceOverride from '@codingame/monaco-vscode-update-service-override'
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import getLocalizationServiceOverride from '@codingame/monaco-vscode-localization-service-override'
import getTelemetryServiceOverride from '@codingame/monaco-vscode-telemetry-service-override'
import getProcessControllerServiceOverride from '@codingame/monaco-vscode-process-explorer-service-override'
import getAssignmentServiceOverride from '@codingame/monaco-vscode-assignment-service-override'
import { EnvironmentOverride } from '@codingame/monaco-vscode-api/workbench'
import { Worker } from './tools/fakeWorker.js'
import defaultKeybindings from './user/keybindings.json?raw'
import defaultConfiguration from './user/configuration.json?raw'
import { TerminalBackend } from './features/terminal.js'
import { openUcdFolder } from './features/openFolder'
import 'vscode/localExtensionHost'

const url = new URL(document.location.href)
const params = url.searchParams
const resetLayout = params.has('resetLayout')
params.delete('resetLayout')

window.history.replaceState({}, document.title, url.href)

await createIndexedDBProviders()

// Workspace definition only in memory. /workspace/* is served live from guest
// via GuestWorkspaceFileSystemProvider (see guestFsProvider.ts).
const fileSystemProvider = new RegisteredFileSystemProvider(false)

const workspaceFile = monaco.Uri.file('/workspace.code-workspace')
fileSystemProvider.registerFile(
  new RegisteredMemoryFile(
    workspaceFile,
    JSON.stringify(
      <IStoredWorkspace>{
        folders: [
          {
            path: '/workspace',
            name: 'workspace'
          }
        ]
      },
      null,
      2
    )
  )
)
const workspace: IWorkspace = {
  workspaceUri: workspaceFile
}

registerFileSystemOverlay(1, fileSystemProvider)

// Workers
const workers: Partial<Record<string, Worker>> = {
  editorWorkerService: new Worker(
    new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
    { type: 'module' }
  ),
  TextMateWorker: new Worker(
    new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url),
    { type: 'module' }
  ),
  OutputLinkDetectionWorker: new Worker(
    new URL('@codingame/monaco-vscode-output-service-override/worker', import.meta.url),
    { type: 'module' }
  ),
  LanguageDetectionWorker: new Worker(
    new URL(
      '@codingame/monaco-vscode-language-detection-worker-service-override/worker',
      import.meta.url
    ),
    { type: 'module' }
  ),
  NotebookEditorWorker: new Worker(
    new URL('@codingame/monaco-vscode-notebook-service-override/worker', import.meta.url),
    { type: 'module' }
  ),
  LocalFileSearchWorker: new Worker(
    new URL('@codingame/monaco-vscode-search-service-override/worker', import.meta.url),
    { type: 'module' }
  )
}

window.MonacoEnvironment = {
  getWorkerUrl(_, label) {
    return workers[label]?.url.toString()
  },
  getWorkerOptions(_, label) {
    return workers[label]?.options
  }
}

// Set configuration before initializing service so it's directly available (especially for the theme, to prevent a flicker)
await Promise.all([
  initUserConfiguration(defaultConfiguration),
  initUserKeybindings(defaultKeybindings)
])

export const constructOptions: IWorkbenchConstructionOptions = {
  enableWorkspaceTrust: true,
  windowIndicator: {
    label: '$(vm) UCDVSC',
    tooltip: 'Offline C/C++ IDE — files live in Alpine /root/workspace',
    command: ''
  },
  workspaceProvider: {
    trusted: true,
    async open() {
      return await openUcdFolder()
    },
    workspace
  },
  developmentOptions: {
    logLevel: LogLevel.Info // Default value
  },
  configurationDefaults: {
    // Same idea as vscode.dev window title, product-named
    'window.title': 'UCDVSC${separator}${dirty}${activeEditorShort}',
    'workbench.colorTheme': 'Default Dark+',
    'workbench.iconTheme': 'vs-seti',
    'editor.editContext': false,
    // Prefer explorer + editor; welcome still available via Help
    'workbench.startupEditor': 'none',
    'files.autoSave': 'afterDelay',
    'files.autoSaveDelay': 1000,
    'editor.experimental.asyncTokenization': false,
    'editor.experimental.preferTreeSitter': [],
    'editor.semanticHighlighting.enabled': false,
    'files.associations': {
      '*.c': 'c',
      '*.h': 'c',
      '*.hh': 'cpp',
      '*.hpp': 'cpp',
      '*.hxx': 'cpp',
      '*.cc': 'cpp',
      '*.cpp': 'cpp',
      '*.cxx': 'cpp'
    }
  },
  defaultLayout: {
    force: resetLayout
  },
  welcomeBanner: undefined,
  productConfiguration: {
    nameShort: 'UCDVSC',
    nameLong: 'UCDVSC',
    applicationName: 'ucdvsc',
    dataFolderName: '.ucd',
    urlProtocol: 'ucdvsc',
    extensionsGallery: {
      serviceUrl: 'https://open-vsx.org/vscode/gallery',
      resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
      extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
      controlUrl: '',
      nlsBaseUrl: ''
    }
  }
}

export const envOptions: EnvironmentOverride = {
  // Otherwise, VSCode detect it as the first open workspace folder
  // which make the search result extension fail as it's not able to know what was detected by VSCode
  userHome: vscode.Uri.file('/')
}

export const commonServices: IEditorOverrideServices = {
  ...getAuthenticationServiceOverride(),
  ...getLogServiceOverride(),
  ...getExtensionServiceOverride({
    // file:// cannot start blob/module workers. Always LocalProcess only,
    // otherwise deltaExtensions waits 60s on a dead Web Worker EH.
    enableWorkerExtensionHost: false
  }),
  ...getExtensionGalleryServiceOverride({
    // Same as monaco-vscode-api demo: Install stays enabled; UCD then loads
    // the vsix on the main thread (file:// cannot run unpkg inside the EH worker).
    webOnly: false
  }),
  ...getModelServiceOverride(),
  ...getNotificationServiceOverride(),
  ...getDialogsServiceOverride(),
  ...getConfigurationServiceOverride(),
  ...getKeybindingsServiceOverride(),
  ...getTextmateServiceOverride(),
  ...getThemeServiceOverride(),
  ...getLanguagesServiceOverride(),
  ...getDebugServiceOverride(),
  ...getPreferencesServiceOverride(),
  ...getOutlineServiceOverride(),
  ...getTimelineServiceOverride(),
  ...getBannerServiceOverride(),
  ...getStatusBarServiceOverride(),
  ...getTitleBarServiceOverride(),
  ...getSnippetServiceOverride(),
  ...getOutputServiceOverride(),
  ...getTerminalServiceOverride(new TerminalBackend()),
  ...getSearchServiceOverride(),
  ...getMarkersServiceOverride(),
  ...getAccessibilityServiceOverride(),
  ...getLanguageDetectionWorkerServiceOverride(),
  ...getStorageServiceOverride({
    fallbackOverride: {
      'workbench.activity.showAccounts': false
    }
  }),
  ...getRemoteAgentServiceOverride({ scanRemoteExtensions: true }),
  ...getLifecycleServiceOverride(),
  ...getEnvironmentServiceOverride(),
  ...getWorkspaceTrustOverride(),
  ...getWorkingCopyServiceOverride(),
  ...getScmServiceOverride(),
  ...getTestingServiceOverride(),
  ...getNotebookServiceOverride(),
  ...getWelcomeServiceOverride(),
  ...getWalkThroughServiceOverride(),
  ...getUserDataProfileServiceOverride(),
  ...getUserDataSyncServiceOverride(),
  ...getTaskServiceOverride(),
  ...getCommentsServiceOverride(),
  ...getEditSessionsServiceOverride(),
  ...getEmmetServiceOverride(),
  ...getInteractiveServiceOverride(),
  ...getIssueServiceOverride(),
  ...getMultiDiffEditorServiceOverride(),
  ...getPerformanceServiceOverride(),
  ...getRelauncherServiceOverride(),
  ...getShareServiceOverride(),
  ...getSurveyServiceOverride(),
  ...getUpdateServiceOverride(),
  ...getExplorerServiceOverride(),
  ...getLocalizationServiceOverride({
    async clearLocale() {
      const url = new URL(window.location.href)
      url.searchParams.delete('locale')
      window.history.pushState(null, '', url.toString())
    },
    async setLocale(id) {
      const url = new URL(window.location.href)
      url.searchParams.set('locale', id)
      window.history.pushState(null, '', url.toString())
    },
    availableLanguages: [
      {
        locale: 'en',
        languageName: 'English'
      }
    ]
  }),
  ...getSecretStorageServiceOverride(),
  ...getTelemetryServiceOverride(),
  ...getProcessControllerServiceOverride(),
  ...getAssignmentServiceOverride()
}
