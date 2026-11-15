---
"@strutvane/logs": patch
---

Redaction hides secrets written as `name=value` or `name: value` in free text (new pattern rule `keyValue`): libpq connection strings (`host=db password=…`), driver errors (`invalid api_key: …`) and JSON inside messages. Only strong names (password, secret, token, api key, private key, credentials) at the end of a word match, so prose such as "password reset" stays readable.
