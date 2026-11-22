/**
 * `auth: false`: ana sayfa arama ekranı misafir (giriş yapmamış) kullanıcı
 * için de çalışır -- public-profile.ts'teki aynı gerekçe. Sadece ?q
 * parametresi okunur, hiçbir kimlik incelenmez; rate limiter bu yüzden
 * her çağrıyı IP üzerinden sınırlıyor.
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/public-profiles-search',
      handler: 'public-profile-search.search',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::engagement-rate-limit', config: { windowMs: 60_000, max: 60 } },
        ],
      },
    },
  ],
};
