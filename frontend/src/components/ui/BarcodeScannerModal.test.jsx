import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BarcodeScannerModal } from '@/components/ui/BarcodeScannerModal'

const decodeFromVideoDevice = vi.fn()
const reset = vi.fn()

// The library is loaded with await import() inside the component; mocking the module id
// intercepts that. No camera is ever touched, which is what makes this testable at all.
vi.mock('@zxing/library', () => ({
  BrowserMultiFormatReader: class {
    decodeFromVideoDevice(...args) {
      return decodeFromVideoDevice(...args)
    }
    reset(...args) {
      return reset(...args)
    }
  },
  DecodeHintType: { POSSIBLE_FORMATS: 'POSSIBLE_FORMATS' },
  BarcodeFormat: { EAN_13: 1, EAN_8: 2, UPC_A: 3, CODE_128: 4 },
}))

const originalMediaDevices = navigator.mediaDevices

describe('BarcodeScannerModal', () => {
  beforeEach(() => {
    decodeFromVideoDevice.mockReset()
    reset.mockReset()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: 'videoinput', deviceId: 'a', label: 'Front Camera' },
          { kind: 'videoinput', deviceId: 'b', label: 'Back Camera' },
        ]),
      },
    })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices,
    })
  })

  it('reports a decoded code exactly once', async () => {
    const onScan = vi.fn()
    decodeFromVideoDevice.mockImplementation((id, el, cb) => {
      cb({ getText: () => '5901234123457' }, null)
      cb({ getText: () => '5901234123457' }, null)
    })

    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={onScan} />)
    await waitFor(() => expect(onScan).toHaveBeenCalledWith('5901234123457'))
    expect(onScan).toHaveBeenCalledTimes(1)
  })

  it('ignores the not-found errors zxing emits on every idle frame', async () => {
    const onScan = vi.fn()
    decodeFromVideoDevice.mockImplementation((id, el, cb) => {
      cb(null, { name: 'NotFoundException' })
    })

    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={onScan} />)
    await waitFor(() => expect(decodeFromVideoDevice).toHaveBeenCalled())
    expect(onScan).not.toHaveBeenCalled()
    expect(screen.queryByText(/couldn't be started/i)).not.toBeInTheDocument()
  })

  it('explains a denied camera permission', async () => {
    navigator.mediaDevices.getUserMedia = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }))

    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={vi.fn()} />)
    expect(await screen.findByText(/permission was denied/i)).toBeInTheDocument()
  })

  it('offers a camera switch when more than one is present', async () => {
    decodeFromVideoDevice.mockImplementation(() => {})
    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /switch camera/i })).toBeInTheDocument()
  })

  it('restarts the reader on the other camera when switched', async () => {
    decodeFromVideoDevice.mockImplementation(() => {})
    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={vi.fn()} />)
    const button = await screen.findByRole('button', { name: /switch camera/i })
    await waitFor(() => expect(decodeFromVideoDevice).toHaveBeenCalled())

    const firstDevice = decodeFromVideoDevice.mock.calls[0][0]
    await userEvent.click(button)
    await waitFor(() => {
      const lastDevice = decodeFromVideoDevice.mock.calls.at(-1)[0]
      expect(lastDevice).not.toBe(firstDevice)
    })
  })

  it('stops the camera when closed', async () => {
    decodeFromVideoDevice.mockImplementation(() => {})
    const { rerender } = render(
      <BarcodeScannerModal open onClose={vi.fn()} onScan={vi.fn()} />,
    )
    await waitFor(() => expect(decodeFromVideoDevice).toHaveBeenCalled())
    rerender(<BarcodeScannerModal open={false} onClose={vi.fn()} onScan={vi.fn()} />)
    await waitFor(() => expect(reset).toHaveBeenCalled())
  })

  it('says so when the page is not a secure context, without touching the camera', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    const originalLocation = window.location
    delete window.location
    window.location = { ...originalLocation, hostname: '192.168.1.20' }

    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={vi.fn()} />)

    expect(await screen.findByText(/https/i)).toBeInTheDocument()
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()

    window.location = originalLocation
    if (original) Object.defineProperty(window, 'isSecureContext', original)
  })

  it('renders nothing and starts no camera while closed', () => {
    render(<BarcodeScannerModal open={false} onClose={vi.fn()} onScan={vi.fn()} />)
    expect(decodeFromVideoDevice).not.toHaveBeenCalled()
  })
})
