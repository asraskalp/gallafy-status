# Incident notes

One file per incident, named `YYYY-MM-DD-short-name.md`. Write it in GitHub's
web editor (**Add file → Create new file**, on a phone too) and commit straight
to `main`. The page shows it within a couple of minutes. To update it, edit the
same file: add a paragraph, change `status`, and when it is over set
`status: resolved` and add the `resolved:` time.

```text
---
title: GST filing is slow
components: gsp
impact: degraded
status: investigating
started: 2026-11-12T10:30+05:30
---
10:45 IST: Sandbox says the GST portal is answering slowly. Filing still works.

11:10 IST: Back to normal.
```

| Field        | Values                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------- |
| `components` | one or more of `console`, `database`, `website`, `gsp`, `email`, `payments`, comma-separated |
| `impact`     | `down`, `degraded`, `maintenance`, or `none` (a note only, the row keeps its colour)         |
| `status`     | `investigating`, `identified`, `monitoring`, `resolved`                                      |
| `started`    | date and time with `+05:30`                                                                  |
| `resolved`   | the same shape; required once `status` is `resolved`                                         |

A note can make a row look worse than the checks found (the GST portal is slow
but Sandbox answers), never better. The text is shown as plain words: no
Markdown, no links. Resolved notes stay on the page for 90 days.

A file the page cannot read is skipped, and the run shows a yellow warning
naming the file and what is wrong; the rest of the page still updates.
