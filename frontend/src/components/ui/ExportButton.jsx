import { useEffect, useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { downloadFile } from '@/lib/download'

export function ExportButton({ url, params, filename }) {
  const [status, setStatus] = useState('idle')
  // The revert timer has to outlive the handler that scheduled it but not the component. Held
  // in a ref so unmounting can cancel it: an export failing as the user navigates away
  // otherwise leaves a timer holding this component's setState for two more seconds.
  const revertRef = useRef(null)

  useEffect(() => () => clearTimeout(revertRef.current), [])

  async function handleClick() {
    setStatus('loading')
    try {
      await downloadFile(url, params, filename)
      setStatus('idle')
    } catch {
      setStatus('error')
      clearTimeout(revertRef.current)
      revertRef.current = setTimeout(() => setStatus('idle'), 2000)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={status === 'loading'}
      className="flex items-center gap-1.5 rounded-xl border border-hairline px-3 py-2 text-[13px] font-medium text-text-secondary hover:bg-canvas-2 hover:text-text-primary disabled:opacity-60"
    >
      {status === 'loading' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
      {status === 'error' ? 'Export failed' : 'Export CSV'}
    </button>
  )
}
