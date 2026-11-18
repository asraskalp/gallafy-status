# status.gallafy.com

The public page that says whether Gallafy is working. It runs here, on GitHub
Pages, apart from Gallafy itself (which runs on Google Cloud), so it keeps
working when the app does not.

**Everything outside `incidents/` is copied from the app repository's
`ops/status-page/` folder by `publish.sh`, and a later copy overwrites an
edit made here.** Change it there.

## What it checks

Every 5 minutes (GitHub may start a run a few minutes late), with a 10-second
limit per request, no key and no cookie. All URLs are in `config.json`.

| Row                    | Request                                                               | Counts as working                                        |
| ---------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Gallafy app            | `console.gallafy.com/api/health` and `/sign-in`                       | `{"status":"ok"}`, and a 200                             |
| Your saved records     | `console.gallafy.com/api/health/ready`                                | `{"database":"ok"}` (the app's `SELECT 1`)               |
| Website                | `gallafy.com/`                                                        | a 200                                                    |
| GST connection         | `api.sandbox.co.in/` (Sandbox, our GSP)                               | any answer under 500 with a JSON body                    |
| E-way bills            | `console.gallafy.com/api/health/gst-systems` and Sandbox's front door | the app's count says `ok` or `idle`, and Sandbox answers |
| E-invoice system (IRP) | the same, for the IRP                                                 | the same                                                 |
| Emails we send         | `email.ap-south-1.amazonaws.com/` (hidden for now)                    | any answer under 500                                     |
| Paying for your plan   | `api.razorpay.com/v1/` (hidden for now)                               | any answer under 500 with a JSON body                    |

Sandbox, Amazon SES and Razorpay are checked at their front door only: an
unauthenticated request that each refuses in its own way. That proves they are
reachable, not that every call through them works, and the page says so.

E-way bills and the IRP are different (row 1619): a vendor can answer its front
door while every e-way bill request times out, so those rows read what the app
itself saw. The app counts its requests to each system and the failed ones (no
answer, a 5xx, an answer it cannot read; a government refusal is not a
failure), and `/api/health/gst-systems` says `failing` when at least half of the
last 15 minutes' requests failed, `idle` when there were none. It never says how
many. When nobody has made an e-way bill in the window, only the front door is
left to go on.

**Down** needs two failed runs in a row. **Slow** needs two slow runs in a row
(over 4 s for our own hosts, 6 s for a provider). One good answer is
**working** again. Nothing checked for 20 minutes reads **not checked**,
including in the visitor's browser if this page itself stops updating.

## Posting a note

See [`incidents/README.md`](incidents/README.md). A note can make a row look
worse than the checks found, never better.

## Showing the hidden rows

`email` and `payments` are checked from day one but shown only once Gallafy
switches them on in production. Set `"public": true` for the row in the app
repository's `ops/status-page/config.json` and run `publish.sh`; the app
repository's tests refuse that edit while the matching production switch is off.

## Where the data lives

- `status-data` branch: `state.json`, the last 90 days of seconds up, slow and
  down per row per IST day. One commit, replaced on every run.
- The published site also serves `data/status.json`: each row's state now.

## Running it locally

Node 24, no install:

```sh
node --test test/state.test.mjs test/render.test.mjs
node probe.mjs --state /tmp/state.json --out /tmp/site     # real checks
node test/preview.mjs /tmp/preview down                    # made-up history, for design review
```
