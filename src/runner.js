import { listAllIosSims } from './sim/ios.js';

export function buildIosCommand({ isExpo, udid, port, simName }) {
  if (isExpo) {
    return `npx expo run:ios --device ${udid} --port ${port}`;
  }
  return `npx react-native run-ios --simulator "${simName}" --port ${port}`;
}

export function buildAndroidCommand({ isExpo, serial, port }) {
  if (isExpo) {
    return `npx expo run:android --device ${serial} --port ${port}`;
  }
  return `RCT_METRO_PORT=${port} npx react-native run-android --deviceId ${serial}`;
}

export function buildMetroCommand({ isExpo, port }) {
  return isExpo
    ? `npx expo start --port ${port}`
    : `npx react-native start --port ${port}`;
}

export function resolveSimNameByUdid(udid) {
  const sims = listAllIosSims();
  const target = sims.find(s => s.udid === udid);
  if (!target) throw new Error(`Simulator UDID not found: ${udid}`);
  const sameName = sims.filter(s => s.name === target.name);
  if (sameName.length > 1) {
    throw new Error(
      `Ambiguous: multiple simulators named "${target.name}" — bare RN takes a name, not UDID. ` +
      `Rename one in the Simulator app.`
    );
  }
  return target.name;
}
