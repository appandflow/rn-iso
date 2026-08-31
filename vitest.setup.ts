// The machine running the suite may legitimately export STIM_* overrides
// (this machine relocates the shared caches to an external SSD via
// ~/.zshenv). Tests assert the DEFAULT layout and set their own overrides,
// so ambient ones must not leak in.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('STIM_')) delete process.env[key];
}
