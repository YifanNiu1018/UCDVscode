import './style.css'
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import { registerGuestWorkspaceFs } from './features/guestFsProvider'
import { registerOpenFolderCommands } from './features/openFolder'
import { installVsixFromFile } from './features/installVsix'

registerGuestWorkspaceFs()

const dummyMainJs = 'data:text/javascript;base64,' + window.btoa('// ucd-main')
const { getApi, registerFileUrl } = registerExtension(
  {
    name: 'ucd-main',
    publisher: 'ucd',
    version: '1.0.0',
    engines: {
      vscode: '*'
    },
    browser: 'extension.js',
    activationEvents: ['*'],
    contributes: {
      commands: [
        {
          command: 'ucd.openFolder',
          title: 'Open Folder…',
          category: 'UCDVSC'
        },
        {
          command: 'ucd.importHostFolder',
          title: 'Import Folder from Computer…',
          category: 'UCDVSC'
        },
        {
          command: 'ucd.installVsix',
          title: 'Install Web Extension from VSIX…',
          category: 'UCDVSC'
        }
      ],
      menus: {
        CommandPalette: [
          { command: 'ucd.openFolder' },
          { command: 'ucd.importHostFolder' },
          { command: 'ucd.installVsix' }
        ]
      }
    }
  },
  ExtensionHostKind.LocalProcess,
  { system: true }
)
registerFileUrl('./extension.js', dummyMainJs)

void getApi().then(async (api) => {
  await registerOpenFolderCommands(api)
  api.commands.registerCommand('ucd.installVsix', () => installVsixFromFile())
})
