import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/routes/ProtectedRoute'
import { ToastContainer } from '@/components/ui/ToastContainer'
import { Login } from '@/pages/Login'
import { Dashboard } from '@/pages/Dashboard'
import { Products } from '@/pages/Products'
import { Orders } from '@/pages/Orders'
import { Purchases } from '@/pages/Purchases'
import { Customers } from '@/pages/Customers'
import { Suppliers } from '@/pages/Suppliers'

function App() {
  return (
    <>
      <ToastContainer />
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/products" element={<Products />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/purchases" element={<Purchases />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/suppliers" element={<Suppliers />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}

export default App
