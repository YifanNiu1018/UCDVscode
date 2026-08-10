import './style.css'
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'
import { registerGuestWorkspaceFs } from './features/guestFsProvider'
import './features/terminal'
import './features/v86Compile'
import { registerOpenFolderCommands } from './features/openFolder'
import { installVsixFromFile } from './features/installVsix'

registerGuestWorkspaceFs()

import '@codingame/monaco-vscode-clojure-default-extension'
import '@codingame/monaco-vscode-coffeescript-default-extension'
import '@codingame/monaco-vscode-cpp-default-extension'
import '@codingame/monaco-vscode-csharp-default-extension'
import '@codingame/monaco-vscode-css-default-extension'
import '@codingame/monaco-vscode-diff-default-extension'
import '@codingame/monaco-vscode-fsharp-default-extension'
import '@codingame/monaco-vscode-go-default-extension'
import '@codingame/monaco-vscode-groovy-default-extension'
import '@codingame/monaco-vscode-html-default-extension'
import '@codingame/monaco-vscode-java-default-extension'
import '@codingame/monaco-vscode-javascript-default-extension'
import '@codingame/monaco-vscode-json-default-extension'
import '@codingame/monaco-vscode-julia-default-extension'
import '@codingame/monaco-vscode-lua-default-extension'
import '@codingame/monaco-vscode-markdown-basics-default-extension'
import '@codingame/monaco-vscode-objective-c-default-extension'
import '@codingame/monaco-vscode-perl-default-extension'
import '@codingame/monaco-vscode-php-default-extension'
import '@codingame/monaco-vscode-powershell-default-extension'
import '@codingame/monaco-vscode-python-default-extension'
import '@codingame/monaco-vscode-r-default-extension'
import '@codingame/monaco-vscode-ruby-default-extension'
import '@codingame/monaco-vscode-rust-default-extension'
import '@codingame/monaco-vscode-scss-default-extension'
import '@codingame/monaco-vscode-shellscript-default-extension'
import '@codingame/monaco-vscode-sql-default-extension'
import '@codingame/monaco-vscode-swift-default-extension'
import '@codingame/monaco-vscode-typescript-basics-default-extension'
import '@codingame/monaco-vscode-vb-default-extension'
import '@codingame/monaco-vscode-xml-default-extension'
import '@codingame/monaco-vscode-yaml-default-extension'
import '@codingame/monaco-vscode-theme-defaults-default-extension'
import '@codingame/monaco-vscode-theme-seti-default-extension'
import '@codingame/monaco-vscode-references-view-default-extension'
import '@codingame/monaco-vscode-search-result-default-extension'
import '@codingame/monaco-vscode-configuration-editing-default-extension'
import '@codingame/monaco-vscode-markdown-math-default-extension'
import '@codingame/monaco-vscode-npm-default-extension'
import '@codingame/monaco-vscode-media-preview-default-extension'
import '@codingame/monaco-vscode-ipynb-default-extension'
import '@codingame/monaco-vscode-simple-browser-default-extension'
import '@codingame/monaco-vscode-mermaid-markdown-features-default-extension'
import '@codingame/monaco-vscode-json-language-features-default-extension'
import '@codingame/monaco-vscode-typescript-language-features-default-extension'
import '@codingame/monaco-vscode-html-language-features-default-extension'
import '@codingame/monaco-vscode-css-language-features-default-extension'
import '@codingame/monaco-vscode-markdown-language-features-default-extension'
import '@codingame/monaco-vscode-emmet-default-extension'

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
