/**
 * Inline stroke icons.
 *
 * No emoji and no icon font. An emoji renders differently on every platform,
 * cannot inherit the text colour, and is read aloud by a screen reader as
 * whatever its name happens to be ("high voltage" for a lightning bolt). These
 * are 24×24 stroke paths that inherit `currentColor`, are hidden from assistive
 * technology, and leave the label to the text or the button's `aria-label`.
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconOverview = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="2" />
    <rect x="14" y="3" width="7" height="5" rx="2" />
    <rect x="3" y="16" width="7" height="5" rx="2" />
    <rect x="14" y="12" width="7" height="9" rx="2" />
  </Svg>
)

export const IconTests = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3h6M10 3v5.5L5.5 17A3 3 0 0 0 8.2 21h7.6A3 3 0 0 0 18.5 17L14 8.5V3" />
    <path d="M7.5 14h9" />
  </Svg>
)

export const IconRuns = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4v16M5 12h6l3-4 3 8 3-4" />
  </Svg>
)

export const IconCoverage = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3a9 9 0 0 1 9 9h-9z" />
  </Svg>
)

export const IconGaps = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M16.2 16.2 21 21M11 8v6M8 11h6" />
  </Svg>
)

export const IconBugs = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8" y="7" width="8" height="12" rx="4" />
    <path d="M12 3v4M6 10H3m18 0h-3M6 15H3m18 0h-3M7.5 20 6 22m10.5-2L18 22" />
  </Svg>
)

export const IconMap = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" />
    <path d="M9 4v14M15 6v14" />
  </Svg>
)

export const IconRequirements = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M14 3v5h5M9 13l2 2 4-4" />
  </Svg>
)

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3m0 14v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M2 12h3m14 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
  </Svg>
)

export const IconProjects = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
)

export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8z" />
    <path d="M18.5 15.5l.8 2.1 2.2.8-2.2.8-.8 2.1-.8-2.1-2.2-.8 2.2-.8z" />
  </Svg>
)

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4.5 19 12 7 19.5z" />
  </Svg>
)

export const IconReplay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12.5l5 5L20 6.5" />
  </Svg>
)

export const IconCross = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4.5 21 19.5H3z" />
    <path d="M12 10v4.5M12 17h.01" />
  </Svg>
)

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M16.2 16.2 21 21" />
  </Svg>
)

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
  </Svg>
)

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  </Svg>
)

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
)

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
)

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M4 20h16" />
  </Svg>
)

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6z" />
    <path d="M8.5 12l2.5 2.5L16 10" />
  </Svg>
)

/** The product mark: the three shapes from the design, in the brand colours. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="11" height="11" rx="3" fill="#1C9ED9" />
      <circle cx="21" cy="8.5" r="5.5" fill="#E35C9A" />
      <path d="M14 25 8 14h12z" fill="#D97706" />
    </svg>
  )
}

/** Small glyph for a test's kind, so the list is readable without colour. */
export function KindIcon({ kind, size = 16 }: { kind?: string; size?: number }) {
  if (kind === 'negative')
    return (
      <Svg size={size}>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12h8" />
      </Svg>
    )
  if (kind === 'edge')
    return (
      <Svg size={size}>
        <path d="M4 18 12 6l8 12z" />
      </Svg>
    )
  if (kind === 'flow')
    return (
      <Svg size={size}>
        <path d="M4 7h7a3 3 0 0 1 3 3v4a3 3 0 0 0 3 3h3" />
        <path d="M17 14l3 3-3 3" />
      </Svg>
    )
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </Svg>
  )
}
