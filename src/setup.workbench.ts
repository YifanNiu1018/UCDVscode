import { initialize as initializeMonacoService } from '@codingame/monaco-vscode-api'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import {
  commonServices,
  constructOptions,
  envOptions
} from './setup.common'
import { hookGalleryWebExtensions, restoreUserExtensions } from './features/installVsix'
import './builtinExtensions'
// Side-effect: register ucd-v86-compile before initializeMonacoService (builtin EH snapshot).
import './features/v86Compile'

let container = document.createElement('div')
container.style.height = '100vh'
document.body.replaceChildren(container)

await initializeMonacoService(
  {
    ...commonServices,
    ...getWorkbenchServiceOverride(),
    ...getQuickAccessServiceOverride({
      isKeybindingConfigurationVisible: () => true,
      shouldUseGlobalPicker: () => true
    })
  },
  container,
  constructOptions,
  envOptions
)

try {
  await hookGalleryWebExtensions()
} catch (e) {
  console.warn('[UCD] gallery extension hook failed', e)
}
try {
  const ids = await restoreUserExtensions()
  if (ids.length > 0) {
    console.info('[UCD] restored web extensions:', ids.join(', '))
  }
} catch (e) {
  console.warn('[UCD] restore extensions failed', e)
}
