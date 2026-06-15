/* global shopify */
// Practitioner Profile Update — Customer Account UI extension entry.
//
// Renders a full-page form letting an approved practitioner edit the data
// they entered at registration. The 8 sections live in profile-sections.jsx
// and each saves independently (its own button). On mount we fetch the
// current profile to autofill the fields.

import '@shopify/ui-extensions/preact'
import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import ApiService from '../../services/FullPageApi.jsx'
import { ProfileSections } from './profile-sections.jsx'

const api = new ApiService()

// Customer-account full-page target entry point.
export default async () => {
  render(<App />, document.body)
}

function App() {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Customer identity from Shopify's authenticated customer-account context.
  // The session-token JWT proves WHO the customer is (backend reads `sub`);
  // the customerId here is just used to build the gid → forwarded as a hint
  // in the body. Both are read every render; they're stable per session.
  const customerId =
    shopify?.authenticatedAccount?.customer?.value?.id || ''

  async function bootstrap() {
    setLoading(true)
    setError('')
    try {
      // Fresh session token PER call — tokens expire ~5 min; Shopify
      // caches them internally so this is cheap.
      const token = await shopify?.sessionToken?.get()
      const res = await api.fetchProfile(token, customerId)
      if (!res || res.status === 'error') {
        const msg = res?.status === 'error' ? res?.message : 'Unable to load your profile.'
        setError(msg || 'Unable to load your profile.')
        setProfile(null)
      } else {
        setProfile(res.result || null)
      }
    } catch (err) {
      setError(err?.message || 'Unable to load your profile.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!customerId) {
      setLoading(false)
      setError('Sign in to your customer account to update your profile.')
      return
    }
    bootstrap()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId])

  // After a successful section save the section component passes us the
  // fresh masked profile so subsequent edits start from server state.
  function handleSaved(updatedProfile) {
    if (updatedProfile) setProfile(updatedProfile)
  }

  if (loading) {
    return (
      <s-page heading="Update your profile">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-spinner accessibilityLabel="Loading your profile" />
          <s-text color="subdued">Loading your profile…</s-text>
        </s-stack>
      </s-page>
    )
  }

  if (error) {
    return (
      <s-page heading="Update your profile">
        <s-banner tone="critical" heading="Couldn't load your profile">
          <s-stack direction="block" gap="base">
            <s-text>{error}</s-text>
            <s-button onclick={bootstrap}>Retry</s-button>
          </s-stack>
        </s-banner>
      </s-page>
    )
  }

  if (!profile) {
    return (
      <s-page heading="Update your profile">
        <s-banner tone="warning" heading="Profile not found">
          <s-text>We couldn't find an application record for this account.</s-text>
        </s-banner>
      </s-page>
    )
  }

  return (
    <s-page heading="Update your profile">
      <s-stack direction="block" gap="large">
        <s-text color="subdued">
          Update the information you entered at registration. Email, name,
          phone, password, and addresses are managed in your Shopify customer
          account settings.
        </s-text>
        <ProfileSections
          api={api}
          customerId={customerId}
          profile={profile}
          onSaved={handleSaved}
        />
      </s-stack>
    </s-page>
  )
}
