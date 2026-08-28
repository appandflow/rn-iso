# @stim-cli/core

The primitives [`stim-cli`](https://www.npmjs.com/package/stim-cli),
[`@stim-cli/metro`](https://www.npmjs.com/package/@stim-cli/metro) and
[`@stim-cli/expo-build-cache`](https://www.npmjs.com/package/@stim-cli/expo-build-cache)
must agree on, implemented once: where the stim-cli config dir and the two
shared caches live (env override > machine config > default), how a build
cache key is derived, and how a cache registers itself for `stim-cli gc`.

This is an internal dependency of those packages, not a user-facing API --
install one of them instead. It is deliberately CJS with no dependencies, so
a `metro.config.js` or an Expo build-cache provider can `require()` it on any
supported Node.
