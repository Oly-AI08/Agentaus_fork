# Agentaus

**An AI chat workspace for conversations, research, files and document creation.**

Agentaus is a browser-based chat app powered by the AgentAUS API. It brings together a familiar chat interface, web-assisted answers, image analysis, reusable prompts, notes, document tools and automatic task agents. An optional local PC companion connects the app to folders you approve, with reviewed changes, backups and Undo.

https://oly-ai08.github.io/Agentaus_fork/

An **AgentAUS API key** is required for AI responses. API access and usage are governed by your AgentAUS account and plan.

## Features

### Chat and conversation controls

- Start, search, rename and delete conversations.
- Save conversation history in the current browser.
- Copy responses and code blocks, export a conversation as Markdown, and regenerate a reply.
- Stop an active response.
- Display formatted responses with headings, lists, tables, links and code blocks.
- Edit a sent prompt using **Edit message → Save & resend**. Agentaus creates a new conversation version from that message and keeps the original conversation in Recents.
- Use a responsive layout with independently toggleable conversation and workspace panels.

### The tools menu

Open the **+** button beside the message box.

| Tool | What you can do |
| --- | --- |
| **Add photos & files** | Attach files from your device for supported reading, analysis and editing tasks. |
| **Add from library** | Import reusable file copies into a personal browser library, search them, attach them to chat and delete saved copies. |
| **Web search** | Enable AgentAUS web-search and webpage-fetch tools for your requests. View source links returned in the web-assisted response. |
| **Sketch** | Draw with a mouse, finger or pen; change colour and width, erase, undo a stroke, and attach the drawing as a PNG. |
| **Template Creator** | Create, edit, import and export reusable prompts. Fill placeholders such as `{{topic}}` before inserting a template into your draft. |
| **Pages** | Create and edit Markdown notes, organize them by space, preview formatting, export notes and attach them to chat. |
| **Presentations** | Create real editable PowerPoint `.pptx` files, read existing decks and prepare supported slide-text edits. |
| **PDF** | Read selectable PDF text, create paginated PDF documents and request structural verification of a selected PDF. |
| **Documents** | Create real Word `.docx` documents and prepare supported edits to existing Word documents. |

Selecting Documents, PDF or Presentations chooses a tool mode. Type what you want and press **Send**. File creation produces a proposal for review before saving or downloading.

**Image generation is not included.** Image uploads, pasted images and sketches can still be analysed.

### Images and sketches

- Paste images directly into the composer with **Ctrl+V** or **Command+V**.
- Preview and remove pasted images before sending.
- Ask about visible objects, screenshots or readable text in an image.
- Draw a sketch and attach its actual PNG image to your message.

Pasted images and sketches are staged locally. They are sent for analysis when you send the message. Image pixels from a normal chat attachment do not survive a page reload; paste or attach the image again if needed. Explicitly importing a file into the personal library is a separate request to keep a browser copy.

### Automatic subagents

Agentaus can ask independent task agents to handle focused parts of a complex request and combine their returned findings.

- Automatic agents do not require you to create profiles first.
- The Subagents panel shows actual queued, running, completed, failed or stopped tasks.
- Up to **two workers** run concurrently, with up to **four automatic delegates per user turn**.
- You can also save reusable agent profiles and run a focused task manually.
- File access follows the selected task permissions. Agents may prepare changes for review; they cannot apply them automatically.

Each task can make additional API requests. Agents do not train or replace the underlying model, and worker agents do not have their own live web-browsing tools. Task-panel runs and raw findings are kept in the current tab session; findings included in a final chat reply can remain in saved history.

### Thinking and context controls

| Level | App context target | Reserved completion budget |
| --- | ---: | ---: |
| **Fast** | 64,000 tokens | 8,000 tokens |
| **Standard** | 128,000 tokens | 8,000 tokens |
| **Deep** | 255,000 tokens | 24,000 tokens |

These are **estimated client-side request budgets**, not confirmed model capacities. Reply budgets include reasoning tokens. The app also reserves safety headroom and accounts for tool definitions. AgentAUS can enforce its own limits.

When a request grows too large, the app leaves out older complete turns while keeping them in your visible chat history. Current instructions and the latest complete turn are retained. If the required current content still does not fit, the app reports an error instead of silently cutting a tool transaction or document request in half.

### Appearance

- Six theme presets and custom accent, background and text colours.
- Six font choices, adjustable text size and line spacing.
- Adjustable reading width and compact message spacing.
- Saved appearance preferences and reset controls.

## Supported files

| File type | Create | Read or analyse | Edit |
| --- | --- | --- | --- |
| **UTF-8 text and code** | Yes | Yes | Reviewed replacements and targeted text edits |
| **Word `.docx`** | Titles, paragraphs, headings and lists | Document text | Targeted text changes that preserve unrelated formatting and package contents |
| **PowerPoint `.pptx`** | Text-focused widescreen slides with titles, bullets and optional notes | Slide text and speaker notes | Targeted slide-text changes; existing speaker notes are read-only |
| **Excel `.xlsx`** | No dedicated new-workbook tool | Supported worksheet content | Targeted cell edits; replacing a formula cell replaces its formula |
| **PDF** | Paginated A4 text documents | Selectable text and structural metadata | Existing PDFs are read-only |
| **PNG, JPEG, WebP, GIF and BMP** | Sketch exports PNG | Image analysis | Read-only |

This is not a full Office editor or terminal. Unsupported binaries, legacy Office formats and arbitrary application files are not automatically editable. Scanned PDFs without selectable text do not have automatic OCR in the PDF reader.

New PDFs use embedded fonts with supported Latin, Greek and Cyrillic coverage. Unsupported glyphs produce a clear error. PowerPoint creation checks text limits; complex layout changes still need review in a presentation editor.

### PDF verification

For an existing PDF, verification checks parsing, page count, page dimensions and metadata. It does **not** certify factual accuracy, accessibility, appearance or absence of visual overflow. Newly generated PDFs additionally have their measured text placement checked during creation.

## Getting started

1. Open the published Agentaus website, or open the supplied `Agentaus.html` directly in a desktop browser.
2. Open the **Settings/key** button.
3. Enter your actual **AgentAUS API key**. A VS Code secret reference is not the key itself.
4. Connect, type a message and press **Send**.
5. Use the **+** menu for additional tools.

Browser-only chat, uploads and supported document downloads do not require the PC companion. Direct saves to selected files or folders depend on browser permissions; a download-copy fallback is used where supported. Desktop Chrome or Edge is recommended for direct folder access.

The API key stays in tab memory. You will need to enter it again after refreshing or opening a new tab.

## Example requests

```text
Create a Word document called meeting-notes.docx with a title,
an agenda and a numbered action list.
```

```text
Create a 6-slide PowerPoint presentation about renewable energy,
with short bullet points and speaker notes.
```

```text
Create a two-page PDF explaining the water cycle.
```

```text
Read the attached report and summarise its main findings.
```

```text
In notes.docx, replace “Draft version” with “Final version”.
Prepare the change for my review.
```

For web-assisted answers, enable **Web search** before sending the request. The app requests web tools separately from custom file tools and displays source links returned with the answer. Returned links are not independently verified citations.

## Optional PC companion

The companion is a local Node.js service for approved folders on your own computer. Obtain the companion package separately if this repository contains only the website HTML. The website alone does not install the service.

### Windows setup

1. Install **Node.js 22 or newer** from [nodejs.org](https://nodejs.org/en/download).
2. Extract the companion package. Keep `server.mjs`, `StartWindows.cmd` and its supplied `Agentaus.html` together.
3. Double-click **StartWindows.cmd**.
4. Choose a folder to approve and enter the website origin you will use.
5. Open [the local Agentaus app](http://127.0.0.1:43127/) in Chrome or Edge on the same PC.
6. Choose **Files → PC companion**, paste the pairing token printed in the companion window, select an approved folder and connect.
7. Enter your AgentAUS API key separately in the app.

Keep the companion window open. Closing it or pressing **Ctrl+C** stops local access. A new pairing token is generated when it restarts. No npm package installation is required for the supplied companion.

The pairing token and AgentAUS API key are different credentials. Both stay in the browser tab's memory rather than persistent browser storage.

### Approving multiple folders

Run this from the folder containing `server.mjs`, replacing the example paths and origin:

```powershell
node server.mjs --origin https://YOUR-USERNAME.github.io --root "C:\Users\YourName\Documents" --root "D:\Projects"
```

The origin contains the protocol and host only. For a project site such as `https://YOUR-USERNAME.github.io/agentaus/`, approve `https://YOUR-USERNAME.github.io` without the project path.

`--port` selects a different local port. `--state-dir` selects a private local backup directory. Use `node server.mjs --help` for the available options. The package also includes `Start.sh` for macOS/Linux with Node.js 22+.

### Review, backups and Undo

1. Ask Agentaus to prepare a change.
2. Open the proposal and review its contents.
3. Choose **Apply changes** to save to an approved location, or download a copy when direct saving is unavailable.

The companion saves previous file bytes before its writes, checks file versions and keeps local backups. Open **PC companion → Local backups** to select a change and confirm Undo. Undo also creates a recovery backup and refuses to replace a detected later version.

Up to **100 recent backup records** and **200 MiB of previous-file snapshots per approved root** are retained. Older records are removed as new saves are made. New-file publication requires a filesystem supporting hard links, such as NTFS.

Normal operating-system permissions still apply. The companion excludes known protected/security paths, traversal paths, symbolic links, junctions and multiply hard-linked files. It does not override Windows permissions or provide shell execution. Avoid editing the same file in another program while applying a change: portable filesystem checks cannot prevent every external-editor race at the final replacement step.

### Drive-wide file lists

The Files dialog also offers a metadata-only drive-index helper. It can list names, paths, sizes and dates while skipping protected/system locations. Importing that index lets chat search the file list; it does not grant access to the listed file contents. Select an actual file or approved folder before asking to read or edit it.

## Browser storage and privacy

| Data | Where it is kept |
| --- | --- |
| Chat history, response instructions and preferences | Browser storage for the current website address/profile |
| Pages and reusable templates | Browser storage; Markdown export for Pages, JSON import/export for templates |
| Explicitly imported personal-library file copies | IndexedDB in the current browser/profile |
| API key and companion pairing token | Current tab memory |
| Normal pasted-image pixels, file-tool context, task runs and pending changes | Current tab session |
| Companion backups | Local disk on the PC running the companion |

Messages and file/image content used for AI responses are sent to **AgentAUS**. Assistant replies and text included in chat history can remain in the browser even though transient file-tool results are not stored as a separate transcript. The companion itself does not send files to an external model service; the browser chat app makes the AgentAUS requests.

Browser data is specific to the website origin. A local address, a Cloudflare address and a GitHub Pages address have separate histories and saved libraries. Clearing site data can remove saved items. Export important material and keep your own copies.

There is currently no Google sign-in, built-in user-account system or cross-device cloud sync. The personal file library is Agentaus browser storage, not ChatGPT Library or Google Drive.

## Practical limits

| Item | Current limit |
| --- | --- |
| Pasted images | Up to 5 images per message, 10,000,000 bytes each |
| Companion file operations | Up to 20 MiB per file; format-specific limits also apply |
| Plain-text file tools | Up to 1 MiB per text file |
| Personal file library | 50 files, 20 MB per file and 100 MB total |
| Templates / Pages | Up to 100 each; their shared saved bundle is limited to 5 MB |
| New Word document text | Up to 1 MiB and 2,000 paragraphs |
| New PDF text | Up to 512 KiB, 1,500 paragraphs and 200 generated pages |
| New PowerPoint deck | Up to 30 slides and 7 short bullets per slide, subject to overflow checks |
| Automatic task agents | Up to 4 delegates per turn and 2 concurrent workers |

These are application limits. Browser storage quotas, available memory, provider limits, file protection and the selected context level can impose lower practical limits.

## Publishing with GitHub Pages

For the browser website, upload a **copy** of `Agentaus.html` named `index.html` to the repository's publishing folder. Keep the companion's original `Agentaus.html` filename unchanged beside its server.

In the repository, choose **Settings → Pages → Deploy from a branch**, select the branch and publishing folder, and save. GitHub Pages hosts the browser website; it does not run the Node.js companion. Each visitor supplies their own AgentAUS key in the app rather than committing a key to the repository.

To update the website, replace `index.html` and commit the change. To use the hosted site with the companion, approve the hosted site's exact origin during companion setup. If a browser blocks an embedded frame or local connection, open the app in its own tab or use the companion's local app address.

## Compatibility and troubleshooting

| Problem | What to check |
| --- | --- |
| GitHub Pages shows a README or a 404 | Put `index.html` at the top level of the selected publishing folder and check the Pages deployment. |
| AgentAUS cannot be reached | Check the key, credits, connection and browser restrictions. Try the app in its own tab. |
| File edit only downloads a copy | Direct-save permission is unavailable. Use a supported browser/folder connection or the companion. |
| Companion will not start | Check Node.js is version 22+ and all package files remain together. Read the console error. |
| Companion cannot connect | Keep it running, check the port/token and approved website origin, and allow a browser local-network prompt when appropriate. |
| A file changed after it was read | Refresh/read the file and prepare a new proposal rather than forcing an overwrite. |
| An old image is unavailable | Paste or attach it again; normal image pixels are not restored after reload. |
| A request exceeds its context budget | Choose a higher level, shorten the request or read smaller file sections. |
| A PDF is scanned, protected or uses unsupported text | Use an unlocked/selectable-text copy, or attach an appropriate page image for separate image analysis. |

The responsive website can be used on an iPad for supported browser features. The companion is local to the PC running it: `127.0.0.1` on an iPad refers to that iPad, not another computer. Remote iPad-to-PC file access is not included.

## Development and checks

The distributed website is self-contained HTML/CSS/JavaScript. It does not require a framework build step. Readable browser source copies accompany the companion package; keep changes synchronized with the code embedded in `Agentaus.html`.

When the companion source and tests are available, run these commands from their folder:

```sh
node --check server.mjs
node --check client.js
node --test server.test.mjs client.test.mjs
```

Automated checks have exercised companion HTTP operations, authorization and path boundaries, backups and Undo, actual file creation/editing, document package compatibility, browser interactions and key/token handling. Provider calls in app tests were mocked; they do not establish live account access. Windows launcher interaction, actual Windows permissions and browser local-network prompts still need verification on the target PC.

## Third-party components

The supplied app includes components such as fflate, PDF.js, PDF-LIB, fontkit and Noto fonts. Retain their embedded notices and the notices provided in the companion package's `LICENSES` folder when redistributing the bundle.

## Useful links

- [AgentAUS API documentation](https://agentaus.com.au/eng/docs/developers/chat-completions-api)
- [Node.js downloads](https://nodejs.org/en/download)
- [GitHub Pages documentation](https://docs.github.com/en/pages)
