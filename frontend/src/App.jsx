import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/routes/ProtectedRoute'
import { ToastContainer } from '@/components/ui/ToastContainer'
import { Login } from '@/pages/Login'
import { Signup } from '@/pages/Signup'
import { VerifyEmail } from '@/pages/VerifyEmail'
import { Subscription } from '@/pages/Subscription'
import { Dashboard } from '@/pages/Dashboard'
import { Products } from '@/pages/Products'
import { Categories } from '@/pages/Categories'
import { Orders } from '@/pages/Orders'
import { Purchases } from '@/pages/Purchases'
import { Customers } from '@/pages/Customers'
import { Expenses } from '@/pages/Expenses'
import { Suppliers } from '@/pages/Suppliers'
import { Settings } from '@/pages/Settings'

function App() {
  return (
    <>
      <ToastContainer />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/signup/verify" element={<VerifyEmail />} />
        <Route path="/subscription" element={<Subscription />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/products" element={<Products />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/purchases" element={<Purchases />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/suppliers" element={<Suppliers />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}

export default App
