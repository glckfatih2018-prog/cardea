# Cardea uygulama planı

## Hedef ve çalışma sınırı

30 Eylül 2026'ya kadar [36 gereksinimi](REQUIREMENTS.md) karşılayan, açık kaynaklı ve testnet üzerinde gösterilebilir bir Cardea sürümü teslim edilecek. Bu plan geliştirmeye hazırdır; tarihler kapasite tahminidir, testlerin geçtiği iddiası değildir. Ürün koduna geçmeden belirsiz teknik seçimler aşağıdaki kabul kapılarıyla çözülecek. Onaylanan üç teslimat korunacak; süre kazanmak için güvenlik ve kanıtlar çıkarılmayacak.

Geliştirme `/Users/mete/cardea` → **Foreveranka/cardea** üzerinde. Mevcut site `/Users/mete/cardea-site` içeriği sürüm kontrolüne alınarak aynı release'e bağlanacak. Son doğrulanmış sürüm **glckfatih2018-prog/cardea** ve mevcut proje sitesi üzerinden teslim edilecek. Eski çalışma notları korunacak, otomatik overwrite/force-push yapılmayacak.

## Mimari kararlar

Bunlar SOW'un nasıl uygulanacağına ilişkin önerilen varsayılanlardır. Anahtar kontrolü, maliyet veya kapsamı değiştiren ihtiyaç çıkarsa seçenek ve sonucu açıkça değerlendirilir; önceden teknik gerekçesi olmayan ek özellik yapılmaz.

| Karar | Seçim | Gerekçe / sınır |
|---|---|---|
| A01 | TypeScript ESM + resmi Stellar SDK; ilk hedef 17.0.1 | Dar işlem motoru, tipler ve aynı serializasyon; Node >=22.12.0 tam sürümle sabitlenecek |
| A02 | Classic testnet + Circle testnet USDC | SOW; Soroban ve çoklu varlık yok |
| A03 | Freighter ilk desteklenen cüzdan | Tek alıcı imzasını erken kanıtlama; diğer cüzdanlar kabul şartı değil |
| A04 | Tek kurumun self-host API + worker + PostgreSQL'i | Kalıcı kanal/kota/işlem kayıtları; hosted multitenancy yok |
| A05 | React/Vite uygulama, mevcut tanıtım tasarımını koruma | Basit frontend; SEO/tanıtım kökte, çalışma ekranları ayrı; doğrulanmış paket sürümleri kurulumda sabitlenecek |
| A06 | Başlangıç 10 channel, kanal başına tek belirsiz/imzalı işlem | 10 eşzamanlı akış; sınırlı kuyruk ve açık busy yanıtı |
| A07 | Sponsor ve fee payer rolleri ayrı; aynı kuruma ait olabilir | Fee bütçesi ve reserve muhasebesi ayrılır; toplam kurum bakiye kanıtı tutulur |
| A08 | Operator yönetim oturumu; alıcı için ek login imzası yok | Tek işlem imzası hedefi korunur. Operator parolası hash'li secret, Secure/HttpOnly/SameSite cookie, CSRF ve login rate limit |
| A09 | Sunucuda kayıtlı üç işlem şablonu: onboarding, graduation, handover | Genel “istediğin XDR'ı imzalat” endpoint'i yok |
| A10 | Tam sayı stroop ve ledger referansları | Yuvarlama ve eski snapshot kaynaklı yanlış muhasebeyi azaltır |
| A11 | Havuz cap'i active+pending reserve; ayrı ücret ve deneme bütçesi | İmza beklerken oversubscription ve başarısız işlemle fee tüketimi engellenir |
| A12 | Tanımlı ekonomik limit yoksa havuz açılamaz | Varsayılan sınırsız kullanım yok; değerler testnet kurulumunda görünür config olur |
| A13 | Raven geliştirme/research aracı; runtime bağımlılığı değil | İmzalama ve uygunluk kararlarını deterministik kod verir |

A08'de kurum kimlik doğrulaması alıcı kimliğiyle karışmaz. İleride SEP-10 eklemek mümkün; bu teslimata ikinci bir kimlik projesi eklenmeyecek. A04 için mevcut VPS kaynakları ölçülmeden kapasite veya yeni hizmet alımı varsayılmayacak. API/worker yerelde ve self-host pakette aynı davranmalı.

## Bileşenler

```text
Tarayıcı: / tanıtım • /app kurum • /onboard/:token alıcı • /docs
      │ HTTPS, dar API şeması, oturum/CSRF ve public endpoint limitleri
      ▼
API ── hazırlama / alıcı imzası kontrolü / havuz politikası
      │
      ├── PostgreSQL: havuz, allowlist, kota, channel lease, request, outbox
      │
      └── Signer adapter: yalnız kayıtlı şablon, sponsor/channel/fee rolü
                         │
Worker ── gönderim ve uzlaştırma ── Stellar testnet Horizon
       └─ rezerv izleme / graduation / kontrollü handover
```

Önerilen monorepo dizilimi:

```text
apps/api/                 HTTP, yönetim oturumu, şema doğrulama
apps/worker/              submit/reconcile/monitor/graduation görevleri
apps/web/                 landing + app + recipient
packages/stellar/         builder, validator, reserve hesapları, signer arayüzü
packages/db/              migration, transaction, kayıt tipleri
tests/unit/               offline deterministik kontroller
tests/integration/       PostgreSQL + ağ adapter hata enjeksiyonu
tests/testnet/           açıkça başlatılan, küçük ve izole ledger senaryoları
docs/                    kullanım, API, güvenlik, self-host, kanıtlar
```

Test düzeneğinde oluşturulan alıcı keypair'leri `tests/testnet` dışına taşınmaz. Gerçek alıcı yolu yalnız public adres ve cüzdandan imzalı işlem kullanır.

## İşlem akışı

1. Alıcı davet bağlantısını açar, testnet cüzdanını bağlar. Bağlantı token'ı alıcı listesine erişim yetkisi vermez; sadece havuzu belirleyen yüksek entropili, iptal edilebilir bir davettir.
2. API havuzun aktifliğini, allowlist'i, adres formatını, hesabın uygunluğunu ve limitleri kontrol eder. Sürüm bir yeni, henüz zincirde olmayan G adresini hedefler. Önceden hesabı olan kullanıcı ya mevcut Cardea sonucu olarak gösterilir ya da açık “bu onboarding akışına uygun değil” sonucu alır; gizlice farklı işlem şablonu oluşturulmaz.
3. DB transaction'ı channel lease ve pending reserve tahsis eder. Duplicate aktif alıcı/request tekilleştirilir. Havuz/sponsor/fee cap'i, sürüm ve canonical gövde saklanır.
4. Sunucu alıcıya unsigned XDR, network, son kullanma, anlaşılır işlem açıklaması döndürür. Başlangıç önerisi 180 saniye geçerliliktir.
5. Freighter **bir işlem imzası** ister. Kullanıcı reddederse yeni sponsorship yapılmaz. Hesap/ağ değişirse eski hazırlık kullanılmaz.
6. Dönen zarf boyut/format/tip açısından doğrulanır. Canonical payload eşitliği, gerçek alıcı imzası, güncel izin/pause ve request durumu tekrar kontrol edilir. İstemci operation/fee/sponsor/sequence belirleyemez.
7. Kayıtlı iç işlem üzerinde kanal/sponsor imzaları oluşturulur; dış ücret sabit politika içinde hazırlanır. Gönderilecek imzalı zarf ve outbox kaydı kalıcı tutulur. Servis imzasını içeren zarf public tarayıcıya verilmez.
8. Worker submit eder; hash, ledger ve result doğrulanınca pending → committed yapılır. Timeout → UNKNOWN; asla başarı tahmini yapılmaz.
9. Alıcı başarı ekranı zincir teyidiyle açılır. Yönetici rezerv, fee, alıcı ve işlem kayıtlarını görür.

## Kurum fonlaması

Havuz kurulumu sponsorun public adresini, ağını, gereken reserve ve fee kapasitesini gösterir. Operator kendi testnet hesabını fonlar; testnet demo kurulumu Friendbot veya operator cüzdanından fonlama kullanabilir. Henüz zincirde bulunmayan hesabın oluşumu ile mevcut hesaba ek fonlama ayrılır. API yalnız public adresin ledger durumunu doğrular; kullanıcıya yanlış ağda ödeme yaptıran serbest bir transfer formu sunmaz. Fonlama teyit edilmeden pool `DRAFT/UNFUNDED` durumundan `ACTIVE` durumuna geçmez. Sponsor/channel/fee hesaplarını kuran operator script'i, alıcı hesabını ve alıcı key'ini yaratmaz.

## Durum makinesi ve yeniden başlama

```text
PREPARED → AWAITING_SIGNATURE → VERIFIED → SUBMIT_READY → SUBMITTED
                                                  │           │
                                                  └→ UNKNOWN ←┘
                                                       │
                                  ledger doğrulaması → CONFIRMED / FAILED

İmza öncesi: CANCELLED / EXPIRED / REJECTED
CONFIRMED sponsorship: ACTIVE → GRADUATING → GRADUATED
                              → HANDING_OVER → TRANSFERRED
                              → EXTERNALLY_CHANGED → uzlaştır / pause
```

- `VERIFIED` sonrası imzalama/submit işlemi ile pause/allowlist değişikliği aynı havuz sürüm politikası altında sıralanır. Önceden üretilmiş imzalı işlem geri alınamaz; pause bu kayıtları iptal edilmiş gibi göstermeyecek.
- Sadece process belleğinde tutulan queue/lock yok. Lease DB'dedir; uzun ağ çağrısı sırasında DB transaction kilidi gereksiz yere açık tutulmaz.
- Süresi geçen unsigned talep kolayca bırakılır. İmzalı/UNKNOWN talepte ledger zamanı ve sonucu uzlaştırılmadan kota veya kanal tekrar kullanılamaz.
- Aynı signed envelope tekrar gönderilebilse de uygulama tek sonucu işler. Aynı hedef için yeni sequence ile yeni işlem oluşturma, önceki sonuç kesinleşmeden yasak.
- Ağ erişimi bozuksa yeni riskli imza üretimi durur; mevcut kayıtlar korunur. DB yazılamıyorsa zincire yan etki başlatılmaz.
- Net başarısızlıkta fee ve sequence etkileri ledger sonucundan okunur; rezerv tahsisi bir kere çözülür.
- Testnet reseti ya da beklenmedik ledger gerilemesi yeni network epoch olarak ele alınır. Eski kayıtlar silinip başarı varsayılmaz; havuz pause, yeniden kurulum ve kanıt arşivi gerekir.

## Veri modeli ve bütünlük

| Tablo | Esas alanlar / kısıtlar |
|---|---|
| `operators`, `sessions` | Tek kurum yetkilisi; hash'li kimlik bilgisi, oturum expiry, audit actor; alıcı seed yok |
| `pools` | network/epoch, sponsor public key, status, policy_version, reserve_cap, fee_cap, deneme limitleri |
| `allowlist_entries` | pool+recipient unique; aktif/revoked; giriş tarihi; import batch |
| `channels` | public key, son sequence, lease request, lease durumu; key materyali ayrı secret store |
| `onboarding_requests` | request id, pool, recipient, lifecycle id, canonical payload/hash, expiry, state, channel+sequence unique |
| `budget_reservations` | pending reserve ve fee üst teklif; request unique; committed/released state |
| `sponsored_entries` | network/epoch+ledger entry identity unique; account/TL ayrımı, unit, current sponsor, last ledger |
| `submissions` | intent id, inner hash, outer hashes, gönderim zamanı, result code, actual fee, ledger |
| `outbox` | idempotent task id, durum/attempt, next attempt; process çökmesine dayanıklı |
| `audit_events` | actor, action, pool/request, eski/yeni state, ledger; private key/token yok |
| `network_snapshots` | reserve unit, latest ledger, epoch, health; freshness sınırı |

Reserve cap azaltılırken yeni cap mevcut active+pending toplamından düşükse işlem reddedilir veya havuz açıkça pause edilir; sessiz negatif kapasite gösterilmez. Havuzdan ayrı sponsor hesabı seviyesinde toplam kapasite de kilit altında rezerve edilir; ileride aynı sponsorun birden fazla havuzda kullanılması aynı XLM'i iki kez tahsis ettirmemeli.

Aynı adresin hesabını kapatıp yeniden açarak fee tüketmesi için otomatik yeniden uygunluk verilmez. Tamamlanmış allowlist kaydı tüketilmiş olarak korunur; yeni lifecycle ancak açık operator kararıyla başlatılır. Bu önerilen varsayılan, sınırsız re-onboarding taahhüdü olmayan SOW kapsamını korur.

## API sınırları

| Yol | Yetki | Davranış |
|---|---|---|
| `POST /api/admin/session` | Operator kimlik bilgisi | Rate limit, oturum cookie; secret loglama yok |
| `POST /api/pools` | Operator | Yalnız sunucuda tanımlı sponsor/config rolleriyle havuz |
| `POST /api/pools/:id/allowlist` | Operator | Bounded CSV/JSON, public G adresleri, duplicate raporu |
| `PATCH /api/pools/:id/policy` | Operator | Cap/pause/izin politikası sürümü, audit |
| `GET /api/pools/:id` | Operator | Active/pending/free reserve, fee, pause nedeni, alıcı listesi |
| `POST /api/onboarding/prepare` | Davet + rate limit | pool token ve adres; yetki ve kota yeniden kontrol |
| `POST /api/onboarding/:id/submit` | Request-bound token + alıcı imzası | Yalnız hazırlanmış canonical gövdeye dönen imza |
| `GET /api/onboarding/:id/status` | Request-bound token | Sınırlı durum/hash; allowlist veya imzalı server zarfı yok |
| `POST /api/pools/:id/handover` | Operator + A/B signer yetkisi | Belirlenmiş sponsorlukları dar bakım şablonuyla devret |
| `GET /api/health` | Sınırlı public | Secret/hesap ayrıntısı yok; ready/unhealthy |

Graduation iç worker işidir. Public revocation ve genel signing endpoint'i yoktur. Sponsor public key'i veya Horizon URL'si istemci isteğiyle serbestçe değiştirilmez. Önerilen request boyut, CSV satır, eşzamanlı request ve fee cap'leri config dosyasında açık olur; limit aşımı tutarlı hata döndürür. Bunların kesin sayıları ilk testnet kurulumu sırasında fixture büyüklüğüne göre seçilir.

## Rezerv izleme, çözme ve devir

Monitor başlangıç önerisi 30 saniyede bir ledger yeniliği kontrolü; graduation 60 saniyede bir uygun kayıt taramasıdır. Bu bir SLA değil, testnet demo varsayılanıdır. Ağ gecikmesi aynı anda farklı ledger'lardan okunan sayıları yanlış karşılaştırmamalı. Her kaydın son ledger'ı ve beklenen in-flight etkileri görünür tutulur.

Expected sponsoring units = kayıtlı başlangıç yükümlülükleri + teyitli aktif Cardea entry units. İlk kurulumda açıklanamayan sponsor yükümlülüğü varsa operatör kayıt eşlemesini tamamlamadan havuz açılmaz. Dış TL kapanması gibi açıklanabilen olaylar reconciler tarafından işlenir; gerçekten açıklanamayan sapma yeni sponsorlukları otomatik durdurur. Resume ancak güncel eşleştirme ve operator kararıyla yapılır.

Graduation worker mevcut Cardea account/TL girişlerinin sahibi olan sponsorla yalnız ilgili girişleri kaldırır. Dinamik kullanılabilir bakiye, yeni minimum ve liabilities hesaplanır; yetersizse bekler. Handover B'nin funding ve imza yetkisini gerektirir; alıcıya ek imza istemez. İki akışta da DB commit sonucu, zincir başarı sonucu teyit edilmeden gerçekleşmez. Asenkron hata alıcı fonlarına ödeme/merge işlemiyle “düzeltilmez”.

Bakım şablonlarının somut sırası aşağıdadır. Kaynak temel CAP-33 ve mevcut yerel `graduate.js` / `handover.js` prototipleridir; yeni ürün sürümünde yeniden test edilecek.

| Şablon | İç operasyonlar ve kaynakları | İmzalar |
|---|---|---|
| Graduation | A kaynaklı RevokeTrustlineSponsorship(alıcı, USDC), A kaynaklı RevokeAccountSponsorship(alıcı) | İç transaction channel + A; dış fee payer. Alıcı imzası yok |
| Handover | B kaynaklı BeginSponsoringFutureReserves(sponsoredId=A); A kaynaklı RevokeAccountSponsorship(alıcı); A kaynaklı RevokeTrustlineSponsorship(alıcı,USDC); A kaynaklı EndSponsoringFutureReserves | İç transaction channel + A + B; dış fee payer. Alıcı imzası yok |

Handover'daki Begin'in hedefi alıcı değil **mevcut sponsor A**'dır; bu fark validator şablonunda açıkça sabitlenir. Her iki şablon yalnız veri tabanında ve güncel ledger'da doğrulanan Cardea entry'lerine uygulanır. Bakım işlemlerinin fee teklifleri de aynı kurum bütçesinde izlenir.

## Anahtar ve dağıtım sınırları

Sponsor/channel/fee özel anahtarları repoda, tarayıcıda, analytics'te veya API yanıtında bulunmayacak. Self-host operatörü secret dosyalarıyla sağlayacak; dosya izinleri ve servis kullanıcı erişimi sınırlanacak. Signer adapter sadece onaylı intent'leri işler. İmzalı zarf potansiyel olarak gönderilebilir veri olduğundan loglara ve public durum endpoint'ine açık verilmez.

Docker Compose veya eşdeğer tek makine paketi API+worker+Postgres'i birlikte başlatacak. TLS/reverse proxy, kalıcı volume, backup/restore ve sağlık kontrolü belgelenecek. Vercel frontend dağıtımı, ayrı API origin kullanılacaksa kesin CORS origin ve CSRF davranışıyla test edilecek; mümkünse aynı origin `/api` yönlendirmesi kullanılır. Sunucu secret'ları frontend build değişkeni olmaz. Yeni ücretli servis bu planın varsayımı değildir.

## Takvim ve kabul kapıları

SOW'daki haftalar iş sırasını tanımlar; aşağıdaki tarihler Eylül sonu hedefi için yeniden planlanmıştır. Teknik işleri uygulayıcı üstlenir; Mete ürün kontrolü ve gerektiğinde kendi cüzdanının etkileşimlerini yapar. Cüzdan özel anahtarının paylaşılması hiçbir kapının koşulu değildir.

| Tarih (TR) | İş paketi | Çıkış / bağımlılık |
|---|---|---|
| **14 Eylül** | P0: repo/lock/lisans/runtime temeli; scriptleri test fixture'a ayırma | Kaynaklar Git'te, gerçek test komutu, offline kontroller; mevcut dosyalar kaybolmaz |
| **15 Eylül** | P1: gerçek Freighter 0-XLM onboarding; SDK17 ve fee0 kapısı | **G1:** bir alıcı imzası, 0XLM/TL/tek signer/fee kanıtı. Geçmeden arayüzü büyütme |
| **16–17 Eylül** | P2: canonical validator, kesin schema, signer rol sınırları | Altered XDR, wrong signature/network, bounded fee testleri |
| **18–19 Eylül** | P3: PostgreSQL, channel lease, outbox, idempotency ve recovery | **G2:** 10 concurrent başarı, duplicate/timeout/restart bütçeyi bozmuyor |
| **20–21 Eylül** | P4: operator oturumu, havuz, funding görünümü, allowlist, cap/pause | 50 adres import, listede olmayan reddi, pending cap kanıtı |
| **22 Eylül** | P5: reserve monitor/reconcile, otomatik pause | **G3:** ledger-reserve ekranı uyumlu; sapma pause; dış kapanma doğru |
| **23–24 Eylül** | P6: graduation ve handover ürün akışları | **G4:** pozitif/negatif lifecycle hash'leri; A/B onayı; alıcı imzasız devir |
| **25 Eylül** | P7: landing/app/recipient UX ve hata durumları | Gerçek cüzdan videosu, doğru pending/failure/success, responsive kontrol |
| **26–27 Eylül** | P8: tüm test matrisi, saldırı/restart/DB restore turu | **G5:** açık kritik hata yok; test çıktısı aynı release'e bağlı |
| **28 Eylül** | P9: self-host/API/security docs, kanıt manifesti, demo | Temiz klon/kurulumdan tekrarlanabilir; video+hash+assertion paketleri |
| **29 Eylül** | P10: Foreveranka sürüm dondurma; Fatih repo/site yayın adayı | **G6:** aynı doğrulanmış kod, links/secrets/config kontrolü, smoke test |
| **30 Eylül** | P11: son düzeltme payı ve üç teslimatın sunuma hazır paketi | D1/D2/D3 manifesti, çalışan testnet app, son release; eksik varsa açık |

Takvim sıkıdır: dört haftalık kapsam 17 güne sığdırılıyor. G1/G2'de gecikme olursa önce çoklu cüzdan, ek grafikler, görsel cilalama ve kapsam dışı entegrasyonlar bırakılır. Doğrulama, cap muhasebesi, 10 concurrent, graduation/devir ve teslimat kanıtları bırakılmaz. 24 Eylül G4 geçmezse 30 Eylül riskini açıkça bildirmek gerekir; “tamamlandı” etiketiyle kapatılmaz.

## Risk kaydı

| Risk | Etki | Önlem / erken sinyal |
|---|---|---|
| Cüzdan hiç fonlanmamış adresi imzalamıyor | Temel tek-imza vaadi bozulur | G1 ilk iki gün; sürüm ve gerçek UI kanıtı |
| İşlem değişikliği doğrulamada kaçıyor | Sponsor yanlış işlemi imzalar | Tam canonical gövde+imza, dar rol şablonu, mutation testleri |
| İmza bekleyen kullanıcılar kanalları/kotayı kilitliyor | Hizmet aksar | Bounded request, expiry, alıcı bazlı tek aktif talep; signed expiry uzlaştırması |
| Ağ timeout'u yanlış tekrar üretiyor | Çift deneme, fee ve state kaybı | Kalıcı UNKNOWN/outbox; ledger reconciliation |
| Fee griefing / kanal tekrarları | Ücret bakiyesi tükenir | Actual fee ledger, deneme ve rate cap, kalıcı consumed allowlist |
| Sponsor bakiye dışarıdan harcanıyor | Yeni sponsorluk/graduation/devir başarısız | Capacity refresh, signer izolasyonu, otomatik pause |
| Anahtar ele geçiyor | Sponsor hesabı yetkileri kötüye kullanılabilir | Testnet-only, minimum erişim, sınırlı bakiye; mutlak güvenlik iddiası yok |
| Monitor yanlış ledger'ları kıyaslıyor | Yanlış pause veya kaçan sapma | Freshness+ledger-aware pending reconciler |
| Alıcı kendi reserve koşulunu değiştiriyor | Graduation başarısız / yanlış rapor | Dinamik minimum, tekrar okuma, atomik revocation, güvenli retry |
| Testnet kesinti/reset | Hash/demo erişimi kaybolur | Snapshot/XDR/video, epoch kontrolü, yeniden üretilebilir fixture |
| Repo/site farklı sürümler | Yanlış teslimat veya secret sızıntısı | Aynı release manifesti, staging→final exact tree karşılaştırması |

## Yayın sırası ve tamamlanma tanımı

1. Foreveranka'da kaynak/lock/test/docs birlikte sürümlenir. Her geçerli test çalışması commit'i, bağımlılıkları ve ağı kaydeder.
2. Release candidate üzerinde test matrisi yürür. Genel “hepsi çalışıyor” beyanı yerine her testin sonucu tutulur.
3. Site, API ve worker aynı sürüm kimliğiyle doğrulanır. Fatih deposundaki değişiklikler okunur; geçmişi silmeden ilgili kod aktarılır, SHA farklıysa ağaç eşitliği kontrol edilir.
4. Public repoda yalnız kaynak, örnek config ve public testnet kanıtı bulunur. Alıcı kişisel verileri, admin oturumu ve tüm secret'lar dışarıda kalır.
5. Nihai site/docs linkleri, D1/D2/D3 videoları/işlem hash'leri ve test çıktıları manifestte birleşir. Yetkili son kabul için açık eksikler listelenir.
6. Mainnet açılmaz; bu sürümün teslimi mainnet güvenliği veya para işletme izni olarak sunulmaz.

Onboarding, graduation ve handover doğrulanmadan yalnız frontend'in yayınlanması tamamlanma değildir. Aktif sponsorlu test hesapları varsa servis kapatılmadan önce durumları kayıt altına alınır; “pause” bunları unsponsor etmez.
