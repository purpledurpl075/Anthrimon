import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Login from './pages/Login'
import OverviewPage from './pages/OverviewPage'
import DeviceList from './pages/DeviceList'
import DeviceDetail from './pages/DeviceDetail'
import DiscoverPage from './pages/DiscoverPage'
import CredentialsPage from './pages/CredentialsPage'
import AccountPage from './pages/AccountPage'
import AlertsPage from './pages/AlertsPage'
import AlertRulesPage from './pages/AlertRulesPage'
import PoliciesPage from './pages/PoliciesPage'
import AdminPage from './pages/AdminPage'
import AddressesPage from './pages/AddressesPage'
import TopologyPage from './pages/TopologyPage'
import AlertDetailPage from './pages/AlertDetailPage'
import InterfaceDetailPage from './pages/InterfaceDetailPage'
import MaintenancePage from './pages/MaintenancePage'
import FlowPage from './pages/FlowPage'
import SyslogPage from './pages/SyslogPage'
import ConfigPage from './pages/ConfigPage'
import CollectorsPage from './pages/CollectorsPage'
import RoutingPage from './pages/RoutingPage'
import WikiPage from './pages/WikiPage'
import ClientPage from './pages/ClientPage'
import PlatformPage from './pages/PlatformPage'
import UsersPage from './pages/UsersPage'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000 } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={
            localStorage.getItem('token') ? <Navigate to="/" replace /> : <Login />
          } />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route path="/"            element={<OverviewPage />} />
            <Route path="/devices"     element={<DeviceList />} />
            <Route path="/devices/:id" element={<DeviceDetail />} />
            <Route path="/devices/:id/interfaces/:ifaceId" element={<InterfaceDetailPage />} />
            <Route path="/discover"    element={<DiscoverPage />} />
            <Route path="/credentials" element={<CredentialsPage />} />
            <Route path="/account"      element={<AccountPage />} />
            <Route path="/alerts"       element={<AlertsPage />} />
            <Route path="/alert-rules"  element={<AlertRulesPage />} />
            <Route path="/policies"     element={<PoliciesPage />} />
            <Route path="/admin"        element={<AdminPage />} />
            <Route path="/addresses"    element={<AddressesPage />} />
            <Route path="/topology"     element={<TopologyPage />} />
            <Route path="/alerts/:id"    element={<AlertDetailPage />} />
            <Route path="/maintenance"   element={<MaintenancePage />} />
            <Route path="/flow"          element={<FlowPage />} />
            <Route path="/syslog"        element={<SyslogPage />} />
            <Route path="/config"        element={<ConfigPage />} />
            <Route path="/collectors"    element={<CollectorsPage />} />
            <Route path="/routing"        element={<RoutingPage />} />
            <Route path="/bgp"            element={<Navigate to="/routing" replace />} />
            <Route path="/wiki"           element={<WikiPage />} />
            <Route path="/wiki/:slug"     element={<WikiPage />} />
            <Route path="/clients/:mac"   element={<ClientPage />} />
            <Route path="/platform"       element={<PlatformPage />} />
            <Route path="/users"          element={<UsersPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
