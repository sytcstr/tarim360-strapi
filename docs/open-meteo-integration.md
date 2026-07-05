# Open-Meteo Integration

The weather ingestion pipeline reads coordinates from active `province`
records and stores normalized snapshots in `agri-weather-cache`. Weather data
must never be written to `agri-price-observation`.

## Runtime safety

- `AGRI_WEATHER_INGESTION_ENABLED` defaults to `false`.
- `OPEN_METEO_BASE_URL` defaults to an empty value.
- No request is made unless both ingestion is enabled and a base URL is set.
- The API key is used only in the outbound request and is removed from the
  stored `sourceUrl`.
- Public role permissions are not enabled by this integration.

## Open-Meteo configuration

For non-commercial evaluation, consult the current Open-Meteo terms before
using `https://api.open-meteo.com/v1/forecast`.

For commercial use, configure the customer endpoint and API key supplied by
Open-Meteo. The current commercial endpoint is documented as
`https://customer-api.open-meteo.com/v1/forecast`.

Open-Meteo states that its free API is for non-commercial use and that weather
data requires attribution under CC BY 4.0. Production configuration must be
reviewed against the latest terms and pricing before enabling ingestion:

- https://open-meteo.com/en/terms
- https://open-meteo.com/en/pricing

The mobile application should display a visible `Weather data: Open-Meteo`
attribution wherever this data is presented.

## Mobile read endpoint

The standard Strapi collection endpoint is:

```text
GET /api/agri-weather-caches
```

Example query for the latest province snapshot:

```text
GET /api/agri-weather-caches?filters[province][slug][$eq]=konya&sort=forecastAt:desc&pagination[limit]=1&populate=province
```

This change does not grant Public role access. Authentication and permission
decisions remain a separate deployment step.
