import { useShellBackground } from '../lib/useShellBackground'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

type Props = {
  className?: string
  /** When true, image backgrounds get the Nexivo wash for glass readability. Gradients skip it. */
  withImageWash?: boolean
}

export function ShellBackgroundLayer({ className, withImageWash = true }: Props) {
  const bg = useShellBackground()

  if (bg.kind === 'gradient') {
    return (
      <div
        className={cx('pointer-events-none absolute inset-0 h-full w-full select-none', className)}
        style={{ background: bg.css }}
        aria-hidden
      />
    )
  }

  return (
    <>
      <img
        src={bg.src}
        alt=""
        aria-hidden
        draggable={false}
        className={cx('pointer-events-none absolute inset-0 h-full w-full select-none object-cover', className)}
      />
      {withImageWash ? (
        <div className="pointer-events-none absolute inset-0 bg-(--nexivo-hero-wash)" aria-hidden />
      ) : null}
    </>
  )
}
