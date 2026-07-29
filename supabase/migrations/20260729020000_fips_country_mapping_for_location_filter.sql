-- FM-2026-07-29-01: make the international location filter actually work.
-- ─────────────────────────────────────────────────────────────────────────────
-- FINDING
-- -------
-- 20260509070000 built foundation_grant_location_profiles with a CASE chain that
-- matches FULL COUNTRY NAMES:
--     when country_raw like '%CANADA%' then 'CANADA'
--     when country_raw like '%KENYA%'  then 'KENYA'
-- But public.foundation_grants.grantee_country stores FIPS 10-4 TWO-LETTER CODES
-- — the country encoding used by IRS Form 990 filings. Verified 2026-07-29:
-- 219 distinct values, every one exactly 2 characters, 7,081,868 rows.
--
-- Consequence: only two branches of that CASE could ever fire — the
-- ('US','USA',…) literal list matched 'US', and the ('UK','GREAT BRITAIN',…)
-- list matched 'UK'. Every other country fell through to the
-- GLOBAL/INTERNATIONAL/WORLDWIDE catch-all. The resulting 152,341-row table held
-- just SIX distinct tokens (UNITED STATES 151,392; GLOBAL/INTERNATIONAL/
-- WORLDWIDE 7,168 each; EUROPE/UNITED KINGDOM 1,383), so filtering by any
-- specific country returned zero rows and every continent filter except Europe
-- was dead.
--
-- WHY NOT AN ISO-3166 LIBRARY
-- ---------------------------
-- FIPS 10-4 is NOT ISO 3166-1 alpha-2, and the collisions are severe — using ISO
-- would silently produce WRONG countries, not missing ones. The dataset itself
-- proves the encoding is FIPS, because codes that collide appear side by side:
--
--   code  FIPS meaning      ISO meaning        rows in this dataset
--   AS    Australia         American Samoa     1,040   ← both AS and AU present
--   AU    Austria           Australia            322
--   CH    China             Switzerland        1,077   ← both CH and SZ present
--   SZ    Switzerland       Eswatini           1,438
--   IS    Israel            Iceland            3,958   ← both IS and IC present
--   IC    Iceland           —                     44
--   ES    El Salvador       Spain                217   ← both ES and SP present
--   SP    Spain             —                    457
--   SG    Senegal           Singapore            168   ← both SG and SN present
--   SN    Singapore         Senegal              354
--   NI    Nigeria           Nicaragua          1,483   ← both NI and NU present
--   GB    Gabon             United Kingdom       324   ← UK is the UK here
--   BY    Burundi           Belarus               60   ← both BY and BO present
--   LT    Lesotho           Lithuania             14   ← both LT and LH present
--
-- APPROACH
-- --------
-- A reference TABLE rather than another inline CASE chain, so corrections are a
-- data fix instead of a migration, and so the mapping is inspectable.
--
-- Region names are chosen to match the exact strings the UI offers in
-- src/components/FilterPanel.tsx INTERNATIONAL_LOCATIONS ('Africa', 'Asia',
-- 'Europe', 'Latin America', 'Middle East', 'North America', 'Oceania',
-- 'Caribbean'), because filter_funders_grant_level upper-cases the incoming CSV
-- and matches tokens exactly. `region2` carries a legitimate second membership
-- (Mexico is both Latin America and North America; Egypt is both Africa and
-- Middle East).
--
-- Codes NOT in the table keep today's behaviour exactly — they still emit
-- GLOBAL/INTERNATIONAL/WORLDWIDE. Unmapped is therefore degraded, never wrong.
-- This migration is deliberately additive: every token the old function emitted
-- is still emitted, so no existing filter can regress.
--
-- US grants continue to emit ONLY 'UNITED STATES' — no region and no global
-- tokens — preserving the current meaning of the "International Locations"
-- facet. Emitting 'NORTH AMERICA' for the 151,392 US-only funders would make
-- that continent match nearly everything.
--
-- NOTE: the refresh is TRUNCATE + INSERT..SELECT over ~7.3M rows and takes
-- roughly 10 minutes. Run it on a DIRECT (5432) psql connection with
-- statement_timeout raised — a pooled connection will drop it.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.grant_country_codes (
  code         text primary key,
  country_name text not null,
  region       text not null,
  region2      text
);

comment on table public.grant_country_codes is
  'FIPS 10-4 country code -> canonical name + region, for foundation_grants.grantee_country (IRS 990 encoding). NOT ISO 3166 — see FM-2026-07-29-01.';

-- Reference data only; read exclusively by the SECURITY DEFINER refresh function,
-- which bypasses RLS as table owner. Deny-all direct access.
alter table public.grant_country_codes enable row level security;

insert into public.grant_country_codes (code, country_name, region, region2) values
  -- ── North America ────────────────────────────────────────────────────────
  ('US','United States','North America',null),
  ('CA','Canada','North America',null),
  ('GL','Greenland','North America',null),
  ('MX','Mexico','Latin America','North America'),
  -- ── Latin America ────────────────────────────────────────────────────────
  ('BR','Brazil','Latin America',null),
  ('AR','Argentina','Latin America',null),
  ('CI','Chile','Latin America',null),
  ('CO','Colombia','Latin America',null),
  ('PE','Peru','Latin America',null),
  ('VE','Venezuela','Latin America',null),
  ('EC','Ecuador','Latin America',null),
  ('BL','Bolivia','Latin America',null),
  ('UY','Uruguay','Latin America',null),
  ('PA','Paraguay','Latin America',null),
  ('GT','Guatemala','Latin America',null),
  ('HO','Honduras','Latin America',null),
  ('ES','El Salvador','Latin America',null),
  ('NU','Nicaragua','Latin America',null),
  ('CS','Costa Rica','Latin America',null),
  ('PM','Panama','Latin America',null),
  ('BH','Belize','Latin America',null),
  ('NS','Suriname','Latin America',null),
  ('GY','Guyana','Latin America',null),
  ('FG','French Guiana','Latin America',null),
  -- ── Caribbean ────────────────────────────────────────────────────────────
  ('RQ','Puerto Rico','Caribbean',null),
  ('JM','Jamaica','Caribbean',null),
  ('DR','Dominican Republic','Caribbean',null),
  ('HA','Haiti','Caribbean',null),
  ('CU','Cuba','Caribbean',null),
  ('BB','Barbados','Caribbean',null),
  ('TD','Trinidad and Tobago','Caribbean',null),
  ('ST','Saint Lucia','Caribbean',null),
  ('AC','Antigua and Barbuda','Caribbean',null),
  ('VC','Saint Vincent and the Grenadines','Caribbean',null),
  ('GJ','Grenada','Caribbean',null),
  ('VQ','United States Virgin Islands','Caribbean',null),
  ('VI','British Virgin Islands','Caribbean',null),
  ('BF','Bahamas','Caribbean',null),
  ('CJ','Cayman Islands','Caribbean',null),
  ('AA','Aruba','Caribbean',null),
  ('NA','Netherlands Antilles','Caribbean',null),
  ('DO','Dominica','Caribbean',null),
  ('MH','Montserrat','Caribbean',null),
  ('TK','Turks and Caicos Islands','Caribbean',null),
  ('AV','Anguilla','Caribbean',null),
  ('SC','Saint Kitts and Nevis','Caribbean',null),
  ('BD','Bermuda','North America',null),
  -- ── Europe ───────────────────────────────────────────────────────────────
  ('UK','United Kingdom','Europe',null),
  ('FR','France','Europe',null),
  ('GM','Germany','Europe',null),
  ('IT','Italy','Europe',null),
  ('NL','Netherlands','Europe',null),
  ('SZ','Switzerland','Europe',null),
  ('BE','Belgium','Europe',null),
  ('SW','Sweden','Europe',null),
  ('SP','Spain','Europe',null),
  ('PL','Poland','Europe',null),
  ('EI','Ireland','Europe',null),
  ('NO','Norway','Europe',null),
  ('DA','Denmark','Europe',null),
  ('FI','Finland','Europe',null),
  ('AU','Austria','Europe',null),
  ('GR','Greece','Europe',null),
  ('PO','Portugal','Europe',null),
  ('HU','Hungary','Europe',null),
  ('EZ','Czech Republic','Europe',null),
  ('LO','Slovakia','Europe',null),
  ('SI','Slovenia','Europe',null),
  ('HR','Croatia','Europe',null),
  ('RO','Romania','Europe',null),
  ('BU','Bulgaria','Europe',null),
  ('LG','Latvia','Europe',null),
  ('LH','Lithuania','Europe',null),
  ('EN','Estonia','Europe',null),
  ('IC','Iceland','Europe',null),
  ('LU','Luxembourg','Europe',null),
  ('MT','Malta','Europe',null),
  ('CY','Cyprus','Europe',null),
  ('AL','Albania','Europe',null),
  ('MK','North Macedonia','Europe',null),
  ('BK','Bosnia and Herzegovina','Europe',null),
  ('MJ','Montenegro','Europe',null),
  ('RI','Serbia','Europe',null),
  ('UP','Ukraine','Europe',null),
  ('BO','Belarus','Europe',null),
  ('MD','Moldova','Europe',null),
  ('RS','Russia','Europe',null),
  ('MN','Monaco','Europe',null),
  ('LS','Liechtenstein','Europe',null),
  ('AN','Andorra','Europe',null),
  ('SM','San Marino','Europe',null),
  ('VT','Vatican City','Europe',null),
  ('GI','Gibraltar','Europe',null),
  ('FO','Faroe Islands','Europe',null),
  ('JE','Jersey','Europe',null),
  ('IM','Isle of Man','Europe',null),
  ('GK','Guernsey','Europe',null),
  ('AX','Akrotiri','Europe',null),
  -- ── Middle East ──────────────────────────────────────────────────────────
  ('IS','Israel','Middle East',null),
  ('TU','Turkey','Middle East','Europe'),
  ('LE','Lebanon','Middle East',null),
  ('JO','Jordan','Middle East',null),
  ('IZ','Iraq','Middle East',null),
  ('IR','Iran','Middle East',null),
  ('SY','Syria','Middle East',null),
  ('SA','Saudi Arabia','Middle East',null),
  ('AE','United Arab Emirates','Middle East',null),
  ('QA','Qatar','Middle East',null),
  ('MU','Oman','Middle East',null),
  ('KU','Kuwait','Middle East',null),
  ('BA','Bahrain','Middle East',null),
  ('YM','Yemen','Middle East',null),
  ('WE','West Bank','Middle East',null),
  ('GZ','Gaza Strip','Middle East',null),
  -- ── Africa ───────────────────────────────────────────────────────────────
  ('SF','South Africa','Africa',null),
  ('KE','Kenya','Africa',null),
  ('NI','Nigeria','Africa',null),
  ('UG','Uganda','Africa',null),
  ('TZ','Tanzania','Africa',null),
  ('GH','Ghana','Africa',null),
  ('ET','Ethiopia','Africa',null),
  ('RW','Rwanda','Africa',null),
  ('ZI','Zimbabwe','Africa',null),
  ('ZA','Zambia','Africa',null),
  ('SG','Senegal','Africa',null),
  ('CG','Democratic Republic of the Congo','Africa',null),
  ('CF','Republic of the Congo','Africa',null),
  ('ML','Mali','Africa',null),
  ('MI','Malawi','Africa',null),
  ('MZ','Mozambique','Africa',null),
  ('BC','Botswana','Africa',null),
  ('LT','Lesotho','Africa',null),
  ('WA','Namibia','Africa',null),
  ('SU','Sudan','Africa',null),
  ('OD','South Sudan','Africa',null),
  ('EG','Egypt','Africa','Middle East'),
  ('MO','Morocco','Africa','Middle East'),
  ('TS','Tunisia','Africa','Middle East'),
  ('AG','Algeria','Africa','Middle East'),
  ('LY','Libya','Africa','Middle East'),
  ('IV','Cote d''Ivoire','Africa',null),
  ('LI','Liberia','Africa',null),
  ('SL','Sierra Leone','Africa',null),
  ('GV','Guinea','Africa',null),
  ('PU','Guinea-Bissau','Africa',null),
  ('GA','Gambia','Africa',null),
  ('BN','Benin','Africa',null),
  ('TO','Togo','Africa',null),
  ('UV','Burkina Faso','Africa',null),
  ('NG','Niger','Africa',null),
  ('CD','Chad','Africa',null),
  ('CM','Cameroon','Africa',null),
  ('CN','Comoros','Africa',null),
  ('MA','Madagascar','Africa',null),
  ('MP','Mauritius','Africa',null),
  ('SE','Seychelles','Africa',null),
  ('ER','Eritrea','Africa',null),
  ('DJ','Djibouti','Africa',null),
  ('SO','Somalia','Africa',null),
  ('BY','Burundi','Africa',null),
  ('CT','Central African Republic','Africa',null),
  ('EK','Equatorial Guinea','Africa',null),
  ('GB','Gabon','Africa',null),
  ('WZ','Eswatini','Africa',null),
  ('AO','Angola','Africa',null),
  ('MR','Mauritania','Africa',null),
  ('CV','Cape Verde','Africa',null),
  ('TP','Sao Tome and Principe','Africa',null),
  -- ── Asia ─────────────────────────────────────────────────────────────────
  ('CH','China','Asia',null),
  ('IN','India','Asia',null),
  ('ID','Indonesia','Asia',null),
  ('RP','Philippines','Asia',null),
  ('JA','Japan','Asia',null),
  ('KS','South Korea','Asia',null),
  ('KN','North Korea','Asia',null),
  ('TW','Taiwan','Asia',null),
  ('TH','Thailand','Asia',null),
  ('VM','Vietnam','Asia',null),
  ('MY','Malaysia','Asia',null),
  ('SN','Singapore','Asia',null),
  ('BG','Bangladesh','Asia',null),
  ('PK','Pakistan','Asia',null),
  ('NP','Nepal','Asia',null),
  ('CE','Sri Lanka','Asia',null),
  ('BT','Bhutan','Asia',null),
  ('BM','Myanmar','Asia',null),
  ('CB','Cambodia','Asia',null),
  ('LA','Laos','Asia',null),
  ('MG','Mongolia','Asia',null),
  ('AF','Afghanistan','Asia',null),
  ('KZ','Kazakhstan','Asia',null),
  ('KG','Kyrgyzstan','Asia',null),
  ('TI','Tajikistan','Asia',null),
  ('TX','Turkmenistan','Asia',null),
  ('UZ','Uzbekistan','Asia',null),
  ('HK','Hong Kong','Asia',null),
  ('MC','Macau','Asia',null),
  ('BX','Brunei','Asia',null),
  ('MV','Maldives','Asia',null),
  ('TT','Timor-Leste','Asia',null),
  ('AM','Armenia','Asia','Europe'),
  ('GG','Georgia','Asia','Europe'),
  ('AJ','Azerbaijan','Asia','Europe'),
  -- ── Oceania ──────────────────────────────────────────────────────────────
  ('AS','Australia','Oceania',null),
  ('NZ','New Zealand','Oceania',null),
  ('FJ','Fiji','Oceania',null),
  ('PP','Papua New Guinea','Oceania',null),
  ('WS','Samoa','Oceania',null),
  ('TN','Tonga','Oceania',null),
  ('NH','Vanuatu','Oceania',null),
  ('BP','Solomon Islands','Oceania',null),
  ('FM','Micronesia','Oceania',null),
  ('RM','Marshall Islands','Oceania',null),
  ('NR','Nauru','Oceania',null),
  ('KR','Kiribati','Oceania',null),
  ('TV','Tuvalu','Oceania',null),
  ('PS','Palau','Oceania',null),
  ('NE','Niue','Oceania',null),
  ('CQ','Northern Mariana Islands','Oceania',null),
  ('GQ','Guam','Oceania',null),
  ('AQ','American Samoa','Oceania',null),
  ('CW','Cook Islands','Oceania',null),
  ('FP','French Polynesia','Oceania',null),
  ('NC','New Caledonia','Oceania',null),
  ('WF','Wallis and Futuna','Oceania',null),
  -- ── long tail present in this dataset ────────────────────────────────────
  ('WI','Western Sahara','Africa',null),
  ('KV','Kosovo','Europe',null),
  ('DX','Dhekelia','Europe',null),
  ('TB','Saint Barthelemy','Caribbean',null),
  ('UC','Curacao','Caribbean',null),
  ('FK','Falkland Islands','Latin America',null),
  ('PC','Pitcairn Islands','Oceania',null),
  ('JQ','Johnston Atoll','Oceania',null),
  ('PF','Paracel Islands','Asia',null)
  -- NOT MAPPED, deliberately: 'OC' (508 grants). It is not a FIPS 10-4 code —
  -- most likely an "other countries" placeholder in the source filing. Guessing
  -- a region would be wrong data; unmapped simply falls through to the
  -- GLOBAL/INTERNATIONAL/WORLDWIDE catch-all, which is today's behaviour.
on conflict (code) do update
  set country_name = excluded.country_name,
      region       = excluded.region,
      region2      = excluded.region2;

-- ─── rebuild the profile builder on top of the mapping ──────────────────────

create or replace function public.refresh_foundation_grant_location_profiles()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table public.foundation_grant_location_profiles;

  insert into public.foundation_grant_location_profiles (foundation_id, location_tokens, updated_at)
  with raw_grants as (
    select
      fg.foundation_id,
      upper(trim(coalesce(fg.grantee_country, ''))) as code
    from public.foundation_grants fg
  ),
  mapped as (
    select
      r.foundation_id,
      (r.code = 'US')      as is_us,
      c.country_name,
      c.region,
      c.region2
    from raw_grants r
    left join public.grant_country_codes c on c.code = r.code
    where r.code <> ''
  ),
  exploded as (
    select
      m.foundation_id,
      unnest(array_remove(array[
        -- specific country (both US and non-US)
        upper(m.country_name),
        -- region tokens: international facet only, so never for US
        case when not m.is_us then upper(m.region)  end,
        case when not m.is_us then upper(m.region2) end,
        -- catch-all: every non-US grant, mapped or not. Preserves the old
        -- behaviour exactly so nothing that matched before stops matching.
        case when not m.is_us then 'GLOBAL'        end,
        case when not m.is_us then 'INTERNATIONAL' end,
        case when not m.is_us then 'WORLDWIDE'     end
      ], null)) as token
    from mapped m
  )
  select
    foundation_id,
    array_agg(distinct token order by token),
    now()
  from exploded
  group by foundation_id;
end;
$$;

-- Same posture as the sibling refresh functions ({postgres, service_role}).
-- REVOKE FROM PUBLIC alone is insufficient on Supabase — default privileges
-- grant EXECUTE to anon/authenticated explicitly on new functions in `public`.
revoke all on function public.refresh_foundation_grant_location_profiles() from public;
revoke execute on function public.refresh_foundation_grant_location_profiles() from anon, authenticated;

-- Backfill. ~10 minutes over ~7.3M rows; needs a direct connection.
select public.refresh_foundation_grant_location_profiles();
