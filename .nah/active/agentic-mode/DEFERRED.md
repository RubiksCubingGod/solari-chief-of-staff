# Deferred

Nothing deferred during bootstrap.

## browser-toolset

- Shadow DOM and iframes are not digested: the digest walks the main frame's light DOM only. A `<select>` option beyond `maxOptions` (24) is neither shown nor selectable. A click whose navigation starts more than 250 ms after the click (client-side scripting) is read as the old page until the next `read`. Owner: real-site hardening (s9), where real pages decide which of these matter.
