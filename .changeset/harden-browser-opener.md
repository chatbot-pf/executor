---
"executor": patch
---

The CLI now validates that a URL is `http`/`https` before handing it to the
operating system's browser opener, and on Windows opens it via
`rundll32 url.dll,FileProtocolHandler` instead of `cmd /c start`. This removes a
path where a crafted URL could be interpreted as a shell command. `executor
login` and the "open in browser" prompts behave the same for normal URLs.
