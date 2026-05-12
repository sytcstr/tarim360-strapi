export default {
  routes: [
    {
      method: 'GET',
      path: '/auth/premium-owners',
      handler: 'auth-flow.premiumOwners',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/auth/check-registration',
      handler: 'auth-flow.checkRegistration',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/auth/update-username',
      handler: 'auth-flow.updateUsername',
      config: { auth: { scope: [] } },
    },
        {
      method: 'POST',
      path: '/auth/register-push-token',
      handler: 'auth-flow.registerPushToken',
      config: { auth: { scope: [] } },
    },

    {
      method: 'POST',
      path: '/auth/unregister-push-token',
      handler: 'auth-flow.unregisterPushToken',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/auth/request-signup-verification',
      handler: 'auth-flow.requestSignupVerification',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/auth/verify-signup',
      handler: 'auth-flow.verifySignup',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/auth/signup-welcome',
      handler: 'auth-flow.sendSignupWelcome',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/auth/request-password-reset',
      handler: 'auth-flow.requestPasswordReset',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/auth/reset-password',
      handler: 'auth-flow.resetPassword',
      config: { auth: false },
    },
  ],
};




