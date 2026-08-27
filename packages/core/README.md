# @rn-iso/core

The primitives [`rn-iso`](https://www.npmjs.com/package/rn-iso),
[`@rn-iso/metro`](https://www.npmjs.com/package/@rn-iso/metro) and
[`@rn-iso/expo-build-cache`](https://www.npmjs.com/package/@rn-iso/expo-build-cache)
must agree on, implemented once: where the rn-iso config dir and the two
shared caches live (env override > machine config > default), how a build
cache key is derived, and how a cache registers itself for `rn-iso gc`.

This is an internal dependency of those packages, not a user-facing API --
install one of them instead. It is deliberately CJS with no dependencies, so
a `metro.config.js` or an Expo build-cache provider can `require()` it on any
supported Node.
