export function iosDevicesFromSimctl(payload) {
  return Object.entries(payload.devices ?? {}).flatMap(([runtimeIdentifier, devices]) =>
    devices.map((device) => ({ ...device, runtimeIdentifier })),
  );
}

export function matchesExpectedIosSimulator(device, expected) {
  return (
    device?.name === expected.name &&
    device?.deviceTypeIdentifier === expected.deviceTypeIdentifier &&
    device?.runtimeIdentifier === expected.runtimeIdentifier
  );
}

export function selectIosCandidate(devices, { arm, baseline, parkedUdid, expectedControl }) {
  const candidates = devices.filter((device) => {
    if (!device.isAvailable) return false;
    return arm === 'stim' ? device.udid === parkedUdid : !baseline.has(device.udid);
  });
  if (candidates.length > 1) return { error: 'multiple-candidate-simulators', candidates };
  const candidate = candidates[0] ?? null;
  if (arm === 'control' && candidate && !matchesExpectedIosSimulator(candidate, expectedControl)) {
    return { error: 'control-simulator-mismatch', candidates, expected: expectedControl };
  }
  return { candidate };
}
