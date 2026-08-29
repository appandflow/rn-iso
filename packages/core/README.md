# @stim-cli/core

The primitives [`stim-cli`](https://www.npmjs.com/package/stim-cli),
[`@stim-cli/metro`](https://www.npmjs.com/package/@stim-cli/metro) and
[`@stim-cli/expo-build-cache`](https://www.npmjs.com/package/@stim-cli/expo-build-cache)
must agree on, implemented once: where the stim-cli config dir and the two
shared caches live (env override > machine config > default), how a build
cache key is derived, and how a cache registers itself for `stim-cli gc`.
Metro cache overrides name a parent directory; the sanitized app name is always
appended beneath it, just as it is beneath the default root.

This is an internal dependency of those packages, not a user-facing API --
install one of them instead. It is ESM-only and has no dependencies. The
`module-sync` export lets supported Node versions load it through `require()`.
