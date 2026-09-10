/**
 * Conjunto de ícones próprio: traço 1.5, grade 16, terminações arredondadas.
 * Consistência é intencional — nenhum ícone de terceiros é carregado da rede.
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="3.75" />
    <path d="M10 10l3 3" />
  </Icon>
);

export const IconSend = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 8L13 3l-4 10-2-4.5-4.5-.5z" />
  </Icon>
);

export const IconStop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </Icon>
);

export const IconPaperclip = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11.5 7.5l-4 4a2.12 2.12 0 01-3-3l5-5a2.12 2.12 0 013 3l-5 5" />
  </Icon>
);

export const IconFolder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 4.5A1 1 0 013 3.5h2.6l1.1 1.4H13a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-8z" />
  </Icon>
);

export const IconFile = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 2h5l3 3v9H4z" />
    <path d="M9 2v3h3" />
  </Icon>
);

export const IconGit = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="4.5" cy="4" r="1.6" />
    <circle cx="4.5" cy="12" r="1.6" />
    <circle cx="11.5" cy="8" r="1.6" />
    <path d="M4.5 5.6v4.8M6 5.2c1.2 1.2 2.2 1.6 4 1.8" />
  </Icon>
);

export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.8v1.6M8 12.6v1.6M2.6 8H4.2M11.8 8h1.6M4.2 4.2l1.1 1.1M10.7 10.7l1.1 1.1M11.8 4.2l-1.1 1.1M5.3 10.7l-1.1 1.1" />
  </Icon>
);

export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6.5l4 3.5 4-3.5" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4l3.5 4L6 12" />
  </Icon>
);

export const IconChevronLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 4L6.5 8 10 12" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
);

export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.3" />
    <path d="M10.5 3.5H3.5a1 1 0 00-1 1v7" />
  </Icon>
);

export const IconStar = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.2l-3.4 1.8.7-3.8L2.5 6.5l3.8-.5z" />
  </Icon>
);

export const IconStarFilled = ({ size = 16, ...p }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" {...p}>
    <path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z" />
  </svg>
);

export const IconArchive = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="3" width="11" height="3" rx="1" />
    <path d="M3.5 6v6a1 1 0 001 1h7a1 1 0 001-1V6M6.5 9h3" />
  </Icon>
);

export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 5h9M6 5V3.5h4V5M4.5 5l.6 8.1a1 1 0 001 .9h3.8a1 1 0 001-.9L11.5 5" />
  </Icon>
);

export const IconFork = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="11.5" cy="3.5" r="1.5" />
    <circle cx="8" cy="12.5" r="1.5" />
    <path d="M4.5 5v1.5c0 1.4 1.6 2 3.5 2s3.5-.6 3.5-2V5" />
  </Icon>
);

export const IconTerminal = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M4.5 6.5L6 8l-1.5 1.5M8 10h3.5" />
  </Icon>
);

export const IconDiff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 2.5v11M11.5 2.5v11M2 6h5M9 10h5" />
  </Icon>
);

export const IconBrain = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.5 3.2A2.2 2.2 0 004.3 5.4c-1 .3-1.8 1.2-1.8 2.3 0 .9.5 1.7 1.3 2.1v.4a2 2 0 002 2h.7" />
    <path d="M9.5 3.2a2.2 2.2 0 012.2 2.2c1 .3 1.8 1.2 1.8 2.3 0 .9-.5 1.7-1.3 2.1v.4a2 2 0 01-2 2H9.5" />
    <path d="M8 2.8v10.4" />
  </Icon>
);

export const IconList = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 4.5h1M6 4.5h7M3 8h1M6 8h7M3 11.5h1M6 11.5h7" />
  </Icon>
);

export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.8l5.5 9.7H2.5z" />
    <path d="M8 6.4v2.8M8 11h.01" />
  </Icon>
);

export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 7.3v3.4M8 5.3h.01" />
  </Icon>
);

export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.2l4.6 1.6v3.6c0 2.7-1.9 5-4.6 6-2.7-1-4.6-3.3-4.6-6V3.8z" />
  </Icon>
);

export const IconSpark = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.2l1.3 3.4 3.4 1.3-3.4 1.3L8 11.6 6.7 8.2 3.3 6.9l3.4-1.3z" />
  </Icon>
);

export const IconPlug = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2a3.5 3.5 0 01-3.5 3.5A3.5 3.5 0 014.5 7.5z" />
    <path d="M8 11v2.5" />
  </Icon>
);

export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 8a5 5 0 10-1.8 3.8" />
    <path d="M13 4.5V8h-3.4" />
  </Icon>
);

export const IconArrowDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3v9M4.5 8.5L8 12l3.5-3.5" />
  </Icon>
);

export const IconExternal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 3h4v4M13 3L8 8" />
    <path d="M12 10v2.5a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1h2.5" />
  </Icon>
);

export const IconKey = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5.5" cy="10.5" r="2.5" />
    <path d="M7.3 8.7L12.5 3.5M10.5 5.5l1.5 1.5M12.8 3.2l1.5 1.5" />
  </Icon>
);

export const IconPanelRight = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M10 3v10" />
  </Icon>
);

export const IconPanelLeft = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M6 3v10" />
  </Icon>
);

export const IconSkill = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5l4.5 2.3v3.4c0 2.2-1.8 4.2-4.5 5.3-2.7-1.1-4.5-3.1-4.5-5.3V4.8z" />
    <path d="M6.2 8.1l1.4 1.4 2.4-2.6" />
  </Icon>
);
