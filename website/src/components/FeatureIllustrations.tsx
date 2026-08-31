import type { ReactNode } from 'react';

type IllustrationProps = { className?: string };

function Frame({ children, className = '' }: IllustrationProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      className={`featureIllustration ${className}`}
      viewBox="0 0 360 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

export function CacheIllustration(props: IllustrationProps): ReactNode {
  return (
    <Frame {...props}>
      <path className="illustGrid" d="M30 48h300M30 100h300M30 152h300M92 24v152M180 24v152M268 24v152" />
      <path className="illustMuted" d="M62 57v88M298 57v88" />
      <rect className="illustPanel" x="92" y="51" width="176" height="98" rx="18" />
      <path className="illustAccentSoft" d="M116 79h88a12 12 0 0 1 12 12v18a12 12 0 0 1-12 12h-88z" />
      <path className="illustAccent" d="m232 86 12 12-23 25-12-12 23-25Z" />
      <path className="illustAccent" d="m207 112 13 12" />
      <circle className="illustDot" cx="118" cy="100" r="5" />
      <path className="illustLine" d="M132 92h60M132 108h42" />
      <path className="illustAccent" d="M42 41h39M279 159h39" />
    </Frame>
  );
}

export function ParallelIllustration(props: IllustrationProps): ReactNode {
  return (
    <Frame {...props}>
      <path className="illustGrid" d="M32 38h296M32 162h296" />
      <rect className="illustPanel" x="42" y="55" width="112" height="92" rx="16" />
      <rect className="illustPanel" x="206" y="55" width="112" height="92" rx="16" />
      <path className="illustAccentSoft" d="M59 76h78v50H59zM223 76h78v50h-78z" />
      <path className="illustLine" d="M72 91h52M72 104h36M236 91h52M236 104h36" />
      <circle className="illustDot" cx="73" cy="132" r="4" />
      <circle className="illustDot" cx="237" cy="132" r="4" />
      <path className="illustAccent" d="M154 100h52M185 87l21 13-21 13" />
      <path className="illustMuted" d="M98 55V39h164v16" />
    </Frame>
  );
}

export function PlatformsIllustration(props: IllustrationProps): ReactNode {
  return (
    <Frame {...props}>
      <rect className="illustPanel" x="48" y="38" width="106" height="126" rx="22" />
      <rect className="illustPanel" x="206" y="38" width="106" height="126" rx="22" />
      <path className="illustAccentSoft" d="M65 63h72v72H65zM223 63h72v72h-72z" />
      <path className="illustAccent" d="M86 111V86l22 12-22 13ZM244 111V86l22 12-22 13Z" />
      <path className="illustLine" d="M88 148h26M246 148h26" />
      <path className="illustMuted" d="M154 79c21-23 31-23 52 0M154 121c21 23 31 23 52 0" />
      <circle className="illustDot" cx="180" cy="76" r="5" />
      <circle className="illustDot" cx="180" cy="124" r="5" />
    </Frame>
  );
}

export function CleanupIllustration(props: IllustrationProps): ReactNode {
  return (
    <Frame {...props}>
      <path className="illustGrid" d="M30 48h300M30 152h300" />
      <rect className="illustPanel" x="48" y="62" width="178" height="76" rx="16" />
      <path className="illustAccentSoft" d="M66 79h142v42H66z" />
      <circle className="illustDot" cx="82" cy="100" r="5" />
      <path className="illustLine" d="M96 92h92M96 108h64" />
      <path className="illustAccent" d="M245 81h60l-8 63h-44l-8-63ZM238 81h74M260 68h30" />
      <path className="illustMuted" d="M262 96v31M278 96v31M294 96v31" />
      <path className="illustAccent" d="m207 129 17 17 28-34" />
    </Frame>
  );
}
