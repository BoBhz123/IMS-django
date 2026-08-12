import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, ScanLine, SwitchCamera } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import {
  SUPPORTED_FORMAT_NAMES,
  describeCameraError,
  isSecureContextForCamera,
  normalizeScan,
  pickCamera,
} from '@/lib/barcode'

/**
 * Camera barcode scanner.
 *
 * `onScan(code)` fires once per accepted read; the caller decides what to do with the code
 * and is responsible for closing the modal.
 *
 * Every call site also accepts the code typed by hand — this is an accelerator, never the
 * only way in. Cameras get denied, break, and are absent on desktops.
 */
export function BarcodeScannerModal({ open, onClose, onScan, title = 'Scan barcode' }) {
  const videoRef = useRef(null)
  const readerRef = useRef(null)
  const streamRef = useRef(null)
  // A single barcode is decoded across many frames; without this the callback fires for
  // each one and an order line is incremented several times from one physical scan.
  const handledRef = useRef(false)

  const [facing, setFacing] = useState('back')
  const [devices, setDevices] = useState([])
  const [status, setStatus] = useState('starting')
  const [error, setError] = useState(null)

  const stop = useCallback(() => {
    readerRef.current?.reset()
    readerRef.current = null
    // reset() releases the reader's own stream, but the permission-probe stream below is
    // ours to stop — miss it and the camera indicator light stays on after closing.
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  useEffect(() => {
    if (!open) {
      stop()
      return
    }

    handledRef.current = false
    setError(null)
    setStatus('starting')

    if (!isSecureContextForCamera()) {
      setStatus('insecure')
      return
    }

    let cancelled = false

    async function start() {
      try {
        // Ask for permission before enumerating: device labels are empty strings until it
        // is granted, so pickCamera would have nothing to match 'back' against.
        streamRef.current = await navigator.mediaDevices.getUserMedia({ video: true })

        const all = await navigator.mediaDevices.enumerateDevices()
        const cameras = all.filter((device) => device.kind === 'videoinput')
        if (cancelled) return
        setDevices(cameras)

        const camera = pickCamera(cameras, facing)

        // Imported here, not at the top of the file: @zxing/library is ~200 kB and the app
        // bundle is already past Vite's size warning. This way it is fetched only when
        // somebody actually opens the scanner.
        const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = await import(
          '@zxing/library'
        )
        if (cancelled) return

        const hints = new Map([
          [
            DecodeHintType.POSSIBLE_FORMATS,
            SUPPORTED_FORMAT_NAMES.map((name) => BarcodeFormat[name]),
          ],
        ])
        const reader = new BrowserMultiFormatReader(hints)
        readerRef.current = reader
        setStatus('scanning')

        reader.decodeFromVideoDevice(
          camera?.deviceId ?? null,
          videoRef.current,
          (result, decodeError) => {
            if (result && !handledRef.current) {
              const code = normalizeScan(result.getText())
              if (code) {
                handledRef.current = true
                onScan(code)
              }
              return
            }
            // zxing reports NotFoundException for every frame without a barcode — which is
            // most of them. Surfacing it would put the modal in a permanent failure state
            // one frame after opening.
            if (decodeError && decodeError.name && decodeError.name !== 'NotFoundException') {
              setError(describeCameraError(decodeError))
            }
          },
        )
      } catch (cameraError) {
        if (cancelled) return
        setStatus('error')
        setError(describeCameraError(cameraError))
      }
    }

    start()

    return () => {
      cancelled = true
      stop()
    }
  }, [open, facing, onScan, stop])

  return (
    <Modal open={open} onClose={onClose} className="max-w-md">
      <div className="flex flex-col gap-3 p-5">
        <h2 className="font-display text-[15px] font-semibold text-text-primary">{title}</h2>

        {status === 'insecure' ? (
          <p className="rounded-xl bg-canvas-2 px-3 py-4 text-[13px] text-text-secondary">
            The camera needs a secure connection. Open this page over HTTPS, or on{' '}
            <code className="font-mono text-[12px]">localhost</code>, to scan. You can type the
            barcode instead.
          </p>
        ) : (
          <div className="relative overflow-hidden rounded-xl bg-black/80">
            <video
              ref={videoRef}
              className="h-56 w-full object-cover"
              muted
              playsInline
              autoPlay
            />
            {status === 'starting' && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 size={18} className="animate-spin text-white/70" />
              </div>
            )}
            {status === 'scanning' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <ScanLine size={110} strokeWidth={1} className="text-white/40" />
              </div>
            )}
          </div>
        )}

        {error && <p className="text-[13px] text-accent-red">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-text-tertiary">
            Or close this and type the barcode.
          </span>
          {devices.length > 1 && (
            <button
              type="button"
              onClick={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
              className="flex items-center gap-1.5 rounded-xl border border-hairline px-2.5 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary"
            >
              <SwitchCamera size={14} />
              Switch camera
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
