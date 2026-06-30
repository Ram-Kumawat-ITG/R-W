/* global shopify */
import '@shopify/ui-extensions/preact'
import { render } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import { apiGet, ApiError } from '../../services/FullPageApi.jsx'
import { Loading, Tabs } from './ui.jsx'
import {
  OverviewSection,
  PatientsSection,
  CommissionsSection,
  PayoutsSection,
  ReferralsSection,
  DiscountsSection,
} from './sections.jsx'

// Customer-account full-page target entry point.
export default async () => {
  render(<App />, document.body)
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'patients', label: 'Patients' },
  { id: 'commissions', label: 'Commissions' },
  { id: 'payouts', label: 'Payouts' },
  { id: 'referrals', label: 'Referrals' },
]

const STATE = {
  LOADING: 'loading',
  READY: 'ready',
  SIGNIN: 'signin',
  DENIED: 'denied',
  ERROR: 'error',
}

function App() {
  const [state, setState] = useState(STATE.LOADING)
  const [profile, setProfile] = useState(null)
  const [tab, setTab] = useState('overview')
  const [errorMsg, setErrorMsg] = useState('')

  const bootstrap = useCallback(async () => {
    setState(STATE.LOADING)
    try {
      const me = await apiGet('me')
      setProfile(me)
      setState(STATE.READY)
    } catch (err) {
      if (err instanceof ApiError && err.httpStatus === 403) setState(STATE.DENIED)
      else if (err instanceof ApiError && err.httpStatus === 401) setState(STATE.SIGNIN)
      else {
        setErrorMsg(err?.message || 'Unable to load your portal.')
        setState(STATE.ERROR)
      }
    }
  }, [])

  useEffect(() => {
    bootstrap()
  }, [bootstrap])

  // 401/403 from any section after load → flip the whole shell.
  const onAuthError = (err) => {
    if (err instanceof ApiError && err.httpStatus === 403) setState(STATE.DENIED)
    else setState(STATE.SIGNIN)
  }

  if (state === STATE.LOADING) {
    return (
      <s-page heading="Referral Portal">
        <Loading label="Loading your portal…" />
      </s-page>
    )
  }

  if (state === STATE.SIGNIN) {
    return (
      <s-page heading="Referral Portal">
        <s-banner tone="warning" heading="Sign in required">
          <s-text>Please sign in to your account to view your practitioner portal.</s-text>
        </s-banner>
      </s-page>
    )
  }

  if (state === STATE.DENIED) {
    return (
      <s-page heading="Referral Portal">
        <s-banner tone="critical" heading="Access restricted">
          <s-text>
            This portal is for approved practitioners only. If you believe this is a
            mistake, please contact support.
          </s-text>
        </s-banner>
      </s-page>
    )
  }

  if (state === STATE.ERROR) {
    return (
      <s-page heading="Referral Portal">
        <s-banner tone="critical" heading="Something went wrong">
          <s-stack direction="block" gap="base">
            <s-text>{errorMsg}</s-text>
            <s-button onClick={bootstrap}>Retry</s-button>
          </s-stack>
        </s-banner>
      </s-page>
    )
  }

  return (
    <s-page heading="Referral Portal">
      <s-stack direction="block" gap="large">
        {profile?.name ? (
          <s-text color="subdued">
            Welcome back, {profile.name}
            {/* {profile.primaryCode ? ` · code ${profile.primaryCode}` : ''} */}
          </s-text>
        ) : null}

        <Tabs tabs={TABS} selected={tab} onSelect={setTab} />

        {tab === 'overview' && <OverviewSection onAuthError={onAuthError} />}
        {tab === 'patients' && <PatientsSection onAuthError={onAuthError} />}
        {tab === 'commissions' && <CommissionsSection mode="all" onAuthError={onAuthError} />}
        {tab === 'payouts' && <PayoutsSection onAuthError={onAuthError} />}
        {tab === 'referrals' && <ReferralsSection onAuthError={onAuthError} />}
      </s-stack>
    </s-page>
  )
}
