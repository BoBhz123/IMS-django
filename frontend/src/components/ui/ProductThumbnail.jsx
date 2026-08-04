import { Package } from 'lucide-react'

const SIZES = {
  xs: 'h-7 w-7',
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
}

export function ProductThumbnail({ image, name, size = 'sm' }) {
  const sizeClass = SIZES[size] ?? SIZES.sm

  if (image) {
    return (
      <img
        src={image}
        alt={name ?? ''}
        className={`${sizeClass} shrink-0 rounded-lg border border-hairline object-cover`}
        loading="lazy"
      />
    )
  }

  return (
    <div
      className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-lg border border-hairline bg-canvas-2 text-text-tertiary`}
    >
      <Package size={14} />
    </div>
  )
}
