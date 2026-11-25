# Agentaus PC Companion

An optional local service for the Agentaus app
(https://oly-ai08.github.io/Agentaus_fork/). The website alone does not
install this service; this package supplies it together with a local copy of
the app (`Agentaus.html`). The companion connects the app to folders you
approve on this computer. Changes come back as proposals for review; the
companion saves previous file bytes before its writes, checks file versions
and keeps local backups with Undo.

## Package contents

| File | Purpose |
| --- | --- |
| `server.mjs` | The local companion service (Node.js; no npm install needed) |
| `client.js` | A terminal client that mirrors the app's companion requests |
| `server.test.mjs`, `client.test.mjs` | Automated test suites for `node --test` |
| `StartWindows.cmd` | Double-click launcher for Windows |
| `Start.sh` | Launcher for macOS and Linux |
| `Agentaus.html` | Local copy of the Agentaus app |
| `app.js`, `styles.css` | Readable browser source used by the local app |
| `README.md` | This file |
| `LICENSES/` | Third-party notices; see `LICENSES/README.md` |

## Windows setup

1. Install **Node.js 22 or newer** from <https://nodejs.org/en/download>.
2. Keep `server.mjs`, `StartWindows.cmd` and `Agentaus.html` together in one
   folder.
3. Double-click **StartWindows.cmd**.
4. Choose a folder to approve and enter the website origin you will use.
5. Open <http://127.0.0.1:43127/> in Chrome or Edge on the same PC.
6. Choose **Files → PC companion**, paste the pairing token printed in the
   companion window, select an approved folder and connect.
7. Enter your AgentAUS API key separately in the app.

Keep the companion window open. Closing it or pressing **Ctrl+C** stops local
access. A new pairing token is generated when it restarts. No npm package
installation is required for the supplied companion.

The pairing token and the AgentAUS API key are different credentials. Both
stay in the browser tab's memory rather than persistent browser storage.

## macOS and Linux

Run the launcher:

```sh
./Start.sh
```

`Start.sh` prompts for the website origin and for one or more approved
folders, then starts the service. It requires Node.js 22+.

Untested on macOS, will be tested on Debian only

## Approved folders and options

The origin contains the protocol and host only. For a project site such as
`https://YOUR-USERNAME.github.io/agentaus/`, approve
`https://YOUR-USERNAME.github.io` without the project path.

```sh
node server.mjs --origin https://YOUR-USERNAME.github.io --root "C:\Users\YourName\Documents" --root "D:\Projects"
```

- `--origin <url>` — website origin allowed to use the service (protocol and
  host only).
- `--root <path>` — approve a folder. Repeat the flag to approve several.
- `--port <port>` — local port (1024–65535). Default: 43127.
- `--state-dir <dir>` — private local backup directory.
- `--help` — list all options.

## Review, backups and Undo

1. Ask Agentaus to prepare a change.
2. Open the proposal and review its contents.
3. Choose **Apply changes** to save to an approved location, or download a
   copy when direct saving is unavailable.

The companion saves previous file bytes before its writes, checks file
versions and keeps local backups. Open **PC companion → Local backups** to
select a change and confirm Undo. Undo also creates a recovery backup and
refuses to replace a detected later version.

Up to **100 recent backup records** and **200 MiB of previous-file snapshots
per approved root** are retained. Older records are removed as new saves are
made. New-file publication requires a filesystem supporting hard links, such
as NTFS.

Normal operating-system permissions still apply. The companion excludes known
protected/security paths, traversal paths, symbolic links, junctions and
multiply hard-linked files. It does not override Windows permissions or
provide shell execution. Avoid editing the same file in another program while
applying a change: portable filesystem checks cannot prevent every
external-editor race at the final replacement step.

## Development and checks

Run these commands from this folder:

```sh
node --check server.mjs
node --check client.js
node --test server.test.mjs client.test.mjs
```

Automated checks have exercised companion HTTP operations, authorization and
path boundaries, backups and Undo, actual file creation/editing, document
package compatibility, browser interactions and key/token handling. Provider
calls in app tests were mocked; they do not establish live account access.
Windows launcher interaction, actual Windows permissions and browser
local-network prompts still need verification on the target PC.

## Third-party components

The supplied app includes components such as fflate, PDF.js, PDF-LIB, fontkit
and Noto fonts. Retain their embedded notices and the notices provided in
this package's `LICENSES` folder when redistributing the bundle.
