import { useCallback, useEffect, useState } from 'react'
import { apiGet, ApiError } from './services/ApiService.jsx'
import { Loading, Banner, Tabs } from './ui.jsx'
import {
  OverviewSection,
  PatientsSection,
  CommissionsSection,
  PayoutsSection,
  ReferralsSection,
} from './sections.jsx'

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

function initials(name) {
  if (!name) return '·'
  const parts = String(name).trim().split(/\s+/)
  const chars = parts.length > 1 ? [parts[0][0], parts[parts.length - 1][0]] : [parts[0][0]]
  return chars.join('').toUpperCase()
}

export default function PractitionerPortal({ loginPageUrl, supportEmail }) {
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
      <div className="portal-page">
        <p className="portal-header__eyebrow">Practitioner portal</p>
        <h1 className="portal-page__heading">Referral Portal</h1>
        <Loading label="Loading your portal…" />
      </div>
    )
  }

  if (state === STATE.SIGNIN) {
    return (
      <div className="portal-page">
        <div className="portal-status-screen">
          <h1 className="portal-page__heading">Sign in to continue</h1>
          <p className="portal-welcome">Your referral dashboard is waiting — just sign in first.</p>
          <Banner tone="warning">
            <p>
              Please{' '}
              <a href={loginPageUrl || '/account/login'}>sign in to your wholesale account</a> to
              view your practitioner portal.
            </p>
          </Banner>
        </div>
      </div>
    )
  }

  if (state === STATE.DENIED) {
    return (
      <div className="portal-page">
        <div className="portal-status-screen">
          <h1 className="portal-page__heading">Access restricted</h1>
          <p className="portal-welcome">This portal is reserved for approved practitioners.</p>
          <Banner tone="critical">
            <p>
              We couldn't find an approved practitioner account for you.
              {supportEmail ? (
                <>
                  {' '}
                  If you believe this is a mistake, reach out to{' '}
                  <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
                </>
              ) : (
                ' If you believe this is a mistake, please contact support.'
              )}
            </p>
          </Banner>
        </div>
      </div>
    )
  }

  if (state === STATE.ERROR) {
    return (
      <div className="portal-page">
        <div className="portal-status-screen">
          <h1 className="portal-page__heading">Something went wrong</h1>
          <p className="portal-welcome">We hit a snag loading your portal.</p>
          <Banner tone="critical">
            <div className="portal-stack portal-stack--tight">
              <p>{errorMsg}</p>
              <div className="portal-banner__action">
                <button type="button" className="portal-btn portal-btn--primary" onClick={bootstrap}>
                  Try again
                </button>
              </div>
            </div>
          </Banner>
        </div>
      </div>
    )
  }

  return (
    <div className="portal-page">
      <div className="portal-header">
        <div>
          <p className="portal-header__eyebrow">Practitioner portal</p>
          <h1 className="portal-page__heading">Referral Portal</h1>
          {profile?.name ? (
            <p className="portal-welcome">
              Welcome back, <strong>{profile.name}</strong>
              
            </p>
          ) : null}
        </div>
        {profile?.name ? <div className="portal-avatar" aria-hidden="true">{initials(profile.name)}</div> : null}
      </div>

      <div className="portal-stack portal-stack--loose">
        <Tabs tabs={TABS} selected={tab} onSelect={setTab} />

        {tab === 'overview' && <OverviewSection onAuthError={onAuthError} />}
        {tab === 'patients' && <PatientsSection onAuthError={onAuthError} />}
        {tab === 'commissions' && <CommissionsSection mode="all" onAuthError={onAuthError} />}
        {tab === 'payouts' && <PayoutsSection onAuthError={onAuthError} />}
        {tab === 'referrals' && <ReferralsSection onAuthError={onAuthError} />}
      </div>
    </div>
  )
}
