import { initialize as initializeMonacoService } from '@codingame/monaco-vscode-api'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import {
  commonServices,
  constructOptions,
  envOptions,
  disableShadowDom
} from './setup.common'
import { hookGalleryWebExtensions, restoreUserExtensions } from './features/installVsix'

// Must run before initializeMonacoService: builtin snapshot is what LocalProcess EH
// sees on file://. Registering afterwards uses deltaExtensions, which can no-op when
// workspace trust/enablement is not ready → "Extension ucd.ucd does not exist or is disabled".
const dummyExtJs = 'data:text/javascript;base64,' + window.btoa('// ucd')
const ucdApi = registerExtension(
  {
    name: 'ucd',
    publisher: 'ucd',
    version: '1.0.0',
    engines: { vscode: '*' },
    browser: 'extension.js',
    activationEvents: ['*']
  },
  ExtensionHostKind.LocalProcess,
  { system: true }
)
ucdApi.registerFileUrl('./extension.js', dummyExtJs)

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

try {
  await ucdApi.setAsDefaultApi()
} catch (e) {
  console.warn('[UCD] setAsDefaultApi failed; using default vscode API', e)
}
