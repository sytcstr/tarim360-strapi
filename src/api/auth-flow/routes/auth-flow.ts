export default {
  routes: [
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
