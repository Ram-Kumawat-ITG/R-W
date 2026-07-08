import { useCallback, useEffect, useState } from 'react'
import { apiGet, ApiError } from './services/ApiService.jsx'
import { Loading, Banner, Tabs } from './ui.jsx'
import { DashboardSection, OrdersSection, CdoSection, ProfileSection } from './sections.jsx'

const BASE_TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'orders', label: 'Orders' },
  { id: 'profile', label: 'Profile' },
]
const CDO_TAB = { id: 'cdo', label: 'CDO' }

const STATE = {
  LOADING: 'loading',
  READY: 'ready',
  SIGNIN: 'signin',
  ERROR: 'error',
}

export default function ClientPortal({ loggedIn, loginPageUrl }) {
  const [state, setState] = useState(loggedIn ? STATE.LOADING : STATE.SIGNIN)
  const [dashboard, setDashboard] = useState(null)
  const [tab, setTab] = useState('dashboard')
  const [errorMsg, setErrorMsg] = useState('')

  const bootstrap = useCallback(async () => {
    setState(STATE.LOADING)
    try {
      await apiGet('me')
      // A lightweight dashboard fetch decides whether the CDO tab renders —
      // no dedicated /me profile field for this; getDashboard already
      // returns `attributed` cheaply.
      const d = await apiGet('dashboard')
      setDashboard(d)
      setState(STATE.READY)
    } catch (err) {
      if (err instanceof ApiError && err.httpStatus === 401) setState(STATE.SIGNIN)
      else {
        setErrorMsg(err?.message || 'Unable to load your account.')
        setState(STATE.ERROR)
      }
    }
  }, [])

  useEffect(() => {
    if (loggedIn) bootstrap()
  }, [loggedIn, bootstrap])

  // 401 from any section after load → flip the whole shell to sign-in.
  const onAuthError = (err) => {
    if (err instanceof ApiError && err.httpStatus === 401) setState(STATE.SIGNIN)
  }

  if (state === STATE.SIGNIN) {
    return (
      <div className="cp-page">
        <div className="cp-status-screen">
          <h1 className="cp-page__heading">Sign in to continue</h1>
          <p className="cp-welcome">Your account dashboard is waiting — just sign in first.</p>
          <Banner tone="warning">
            <p>
              Please <a href={loginPageUrl || '/account/login'}>sign in to your account</a> to view your
              orders and account details.
            </p>
          </Banner>
        </div>
      </div>
    )
  }

  if (state === STATE.LOADING) {
    return (
      <div className="cp-page">
        <p className="cp-header__eyebrow">My account</p>
        <h1 className="cp-page__heading">Client Portal</h1>
        <Loading label="Loading your account…" />
      </div>
    )
  }

  if (state === STATE.ERROR) {
    return (
      <div className="cp-page">
        <div className="cp-status-screen">
          <h1 className="cp-page__heading">Something went wrong</h1>
          <p className="cp-welcome">We hit a snag loading your account.</p>
          <Banner tone="critical">
            <div className="cp-stack cp-stack--tight">
              <p>{errorMsg}</p>
              <div className="cp-banner__action">
                <button type="button" className="cp-btn cp-btn--primary" onClick={bootstrap}>
                  Try again
                </button>
              </div>
            </div>
          </Banner>
        </div>
      </div>
    )
  }

  const tabs = dashboard?.attributed ? [...BASE_TABS, CDO_TAB] : BASE_TABS

  return (
    <div className="cp-page">
      <div className="cp-header">
        <div>
          <p className="cp-header__eyebrow">My account</p>
          <h1 className="cp-page__heading">Client Portal</h1>
        </div>
      </div>

      <div className="cp-stack cp-stack--loose">
        <Tabs tabs={tabs} selected={tab} onSelect={setTab} />

        {tab === 'dashboard' && <DashboardSection onAuthError={onAuthError} onViewOrders={() => setTab('orders')} />}
        {tab === 'orders' && <OrdersSection onAuthError={onAuthError} />}
        {tab === 'cdo' && dashboard?.attributed && <CdoSection onAuthError={onAuthError} />}
        {tab === 'profile' && <ProfileSection onAuthError={onAuthError} />}
      </div>
    </div>
  )
}
