# ChatGPT Queue — Chrome Extension

This extension lets you queue prompts while ChatGPT is generating a response. Press Alt+Enter to add a typed prompt to the queue; when the model finishes, the first queued prompt is automatically sent.

Installation (developer / manual load):

1. Open Chrome and go to chrome://extensions
2. Enable "Developer mode" (toggle top-right)
3. Click "Load unpacked" and select this project folder (`chatgpt_queue`).

Usage:

- While ChatGPT (chat.openai.com or chatgpt.com) is generating, type your next prompt in the input box.
- Press Alt+Enter to add it to the queue (it will clear the input).
- The queue panel appears above the input box and shows queued prompts. Click ✏️ to load a prompt into the input for editing, or 🗑️ to remove it.
- When ChatGPT finishes a response, the extension will automatically send the next queued prompt.

Notes & heuristics:

- The extension uses several heuristics to detect whether ChatGPT is generating (Stop button, role=status, etc.). If you see incorrect behavior, please open the content script and adjust `isGenerating()` heuristics for the current page structure.
- The queue persists using extension storage.

Privacy & permissions:

- The extension requests access to https://chat.openai.com/* and https://chatgpt.com/* and uses the page DOM to implement features. The queue is stored locally via Chrome storage.

Feedback / improvements:

- Make selector heuristics more robust.
- Add UI animations and keyboard shortcuts to manage the queue (send now, move up/down).
