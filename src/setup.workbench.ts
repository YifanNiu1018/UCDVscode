import { initialize as initializeMonacoService } from '@codingame/monaco-vscode-api'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import { ExtensionHostKind } from '@codingame/monaco-vscode-extensions-service-override'
import { registerExtension } from '@codingame/monaco-vscode-api/extensions'
import {
  commonServices,
  constructOptions,
  envOptions,
  disableShadowDom
} from './setup.common'
import { hookGalleryWebExtensions, restoreUserExtensions } from './features/installVsix'

let container = document.createElement('div')
container.style.height = '100vh'
document.body.replaceChildren(container)

if (!disableShadowDom) {
  const shadowRoot = container.attachShadow({
    mode: 'open'
  })
  const workbenchElement = document.createElement('div')
  workbenchElement.style.height = '100vh'
  shadowRoot.appendChild(workbenchElement)
  container = workbenchElement
}

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

await registerExtension(
  {
    name: 'ucd',
    publisher: 'ucd',
    version: '1.0.0',
    engines: {
      vscode: '*'
    }
  },
  ExtensionHostKind.LocalProcess
).setAsDefaultApi()
