# Cardea test ve teslimat matrisi

Bu dosya **planlanan kabul testlerini** tanımlar. T01–T50 bu araştırma çalışmasında yürütülmüş değildir. Yalnız [ayrı çevrimdışı araştırma deneyi](evidence/xdr-check.json) yedi kontrolü geçmiştir; bu yedi kontrol aşağıdaki 50 ürün testinin tamamlanması anlamına gelmez.

Katmanlar: **U** offline birim, **I** API/DB/worker entegrasyon ve hata enjeksiyonu, **N** küçük izole Stellar testnet senaryosu, **B** gerçek tarayıcı/cüzdan, **R** temiz kurulum/release kontrolü. Beklenmeyen başarı da hata sayılır; test runner sıfırdan farklı kod döndürür. Ağ arızası ile beklenen protokol reddi birbirine karıştırılmaz. Testnet testleri açık komutla başlatılır, varsayılan unit suite otomatik para/fonlama işlemi yapmaz.

## D1: işlem motoru ve saldırı senaryoları

| Test | Katman | Senaryo | Beklenen sonuç / kanıt |
|---|---|---|---|
| T01 | N | Yeni adres, dört operasyon, fee bump | Önce hesap yok; sonra XLM0, doğru USDC TL, tek alıcı signer; account sponsor+TL sponsor; reserve3 unit; yalnız fee kadar toplam kurum bakiye farkı |
| T02 | U/I | Signed XDR'da memo, süre veya precondition değiştir | Sponsor imzası üretilmeden reddet; kayıtlı gövde değişmez |
| T03 | U/I | USDC kodu/issuer/limit değiştirme | Her alan ayrı mutation; canonical eşitlik başarısız |
| T04 | U/I | StartingBalance>0, destination/source değiştirme; Payment/SetOptions/AccountMerge ekleme | Her varyant ayrı reddedilir; fon aktarımı ve signer eklenmez |
| T05 | U/I | Eksik/yanlış alıcı imzası, doğru hint yanlış signature, duplicate/ek signature | Kriptografik kontrol/politika reddi; fee yok |
| T06 | U/I/B | Mainnet passphrase ile imza; cüzdan yanlış ağda | UI uyarısı ve backend reddi; testnet servisi mainnet submit yapmaz |
| T07 | U/I | Operasyon sırası/sayısı değişikliği, malformed/aşırı büyük XDR, beklenmeyen envelope tipi | Parse/şema limiti içinde kontrollü reddet; crash veya genel signer çağrısı yok |
| T08 | U/N | Dört operasyon, iç fee0, dış taban ücret; fee cap üstü teklif | SDK hesabı ve ledger fee ayrı doğrulanır; cap aşımı submit edilmez; wallet fee0 kapısı kaydedilir |
| T09 | I/N | Aynı signed request tekrar gönderilir | Tek lifecycle/rezerv commit; durum aynı işlemi gösterir; yeni sequence yaratılmaz |
| T10 | I/N | 10 farklı alıcı aynı anda hazırlanır/imzalar | 10 başarılı hash, unique channel+sequence, doğru toplam30 unit; çakışma yok |
| T11 | I | API timeout: zincirde başarılı / başarısız / henüz bilinmiyor varyantları | UNKNOWN korunur; teyide göre bir kere commit/release; fee ledger sonucundan |
| T12 | I | Aynı adres iki paralel istek, iki pool veya iki process | DB unique/lock; bir aktif tahsis; ikinci deneme yeni fee oluşturmaz |
| T13 | I | Prepare sonrası, imza sonrası, submit öncesi/sonrası process öldür | Her sınırda restart; outbox+lease durumu korunur; signed UNKNOWN kanal yeniden kullanılmaz |
| T14 | I | İmza penceresi dolan unsigned ve signed belirsiz işlemler | Unsigned bırakılır; signed için ledger expiry/sonuç/sequence teyidi beklenir |
| T15 | I | Tekrarlı prepare/reject/fail çağrılarıyla channel ve fee tüketimi | Request/adres/IP/deneme bütçeleri; busy/limit yanıtı; sınırsız dış fee teklifi yok |
| T16 | I/N | Dış fee yenilenirken aynı inner hash; harici sequence değişikliği | Aynı intent'e dış hash eklenir; outcome uzlaştırılır; yanlış yeni iç işlem yok |

T10 testnet üzerinde kontrollü fonksiyon testidir; yüksek QPS stres saldırıları kamu testnet'ine uygulanmaz. T02–T07'de tam sponsor imzalama yolu spy ile izlenir; yalnız validator'ın false dönmesi yeterli değildir.

## D2: yönetim, muhasebe ve dayanıklılık

| Test | Katman | Senaryo | Beklenen sonuç / kanıt |
|---|---|---|---|
| T17 | I/B | Yetkili havuz oluşturur; listede olmayan adres başvurur | Havuz yaratılır; uygun olmayan adres için transaction hazırlanmaz |
| T18 | I/B | 50 geçerli adres import; duplicate, bozuk, M/C/S adresi varyantları | 50 unique G adresi kaydı; hatalılar açık rapor; secret benzeri girdi loglanmaz; CSV export formül injection yok |
| T19 | I/N | 50 alıcı capacity önizlemesi ve kısmi onboarding | Örnekte75XLM reserve ihtiyacı ayrı; pending/active/free ve fee ayrımı; ledger ile aynı birimler |
| T20 | I | Son kotaya iki eşzamanlı alıcı; çok pool tek sponsor | Cap veya sponsor kapasitesi bir kez tahsis edilir; negatif free yok |
| T21 | I/N/B | Prepare öncesi/sonrası pause veya allowlist revoke | Yeni/henüz imzalanmamış intent engellenir; in-flight açıkça gösterilir; mevcut sponsorship değişmez |
| T22 | I | Sponsoring units beklenenden farklı, açıklanamayan giriş | Otomatik pause ve audit nedeni; kendiliğinden resume yok |
| T23 | I | Fee cap, gün sonu sınırı, failed tx actual fee, paralel fee tahsisi | Bütçe persisted; başarısız dahil actual fee işlenir; gün değişimi/restart limit kaçırmaz |
| T24 | I/B | Oturumsuz/yanlış yetkili admin çağrısı ve brute force | 401/403/rate limit; havuz, funding config ve signer role değişmez |
| T25 | I/B | CSRF, yanlış origin, script içeren pool adı/adres notu | Mutation reddi; HTML escape; cookie/CORS doğru; secret response yok |
| T26 | I | Eski Horizon snapshot / ledger gecikmesi / kısa kesinti | Karışık ledger'dan kesin sapma kararı verilmez; freshness bozuksa yeni riskli işlem durur |
| T27 | I/N | Alıcı TL'ını dışarıdan kapatır | İşlem/ledger kanıtıyla sponsorluk kaydı azalır; eksik entry'ye tekrar revoke yapılmaz |
| T28 | I | İmza bekletme ile bütün channel'ları tutma | Alıcı başına tek aktif request; bounded queue+expiry; kota çalınmaz, operator durumu görebilir |
| T29 | I | Postgres write hatası, rollback, backup restore | Persist edilemeyen intent gönderilmez; restore sonrası ledger uzlaştırılmadan havuz açılmaz |

## D3: yaşam döngüsü ve kullanıcı deneyimi

| Test | Katman | Senaryo | Beklenen sonuç / kanıt |
|---|---|---|---|
| T30 | N | İzole sponsorlu alıcı kendi yeterli XLM'ini edinir | Worker graduation yapar; account+TL sponsor kalkar; num_sponsoring3→0; alıcı signer sabit; rezerv transferi yok |
| T31 | I/N | Sıfır veya yetersiz XLM ile graduation | Worker bekler; zorlanan protokol senaryosu beklenen reserve hatasıyla reddedilir; ledger değişmez |
| T32 | I/N | Ek subentry, liabilities veya balance graduation arasında değişir | Dinamik yeterlilik; yarışta güvenli başarısızlık; yarım account/TL kaldırma yok |
| T33 | I/N | Graduation worker retry/restart; entry kısmen dışarıdan kaldırılmış | Kalan girişler ledger ile uzlaştırılır; double release/muhasebe eksiği yok |
| T34 | N | A→B sponsor devri, alıcı hâlâ XLM0 | A−3/B+3; alıcının bakiyesi/signers aynı; alıcı imzası yok; devir hash'i |
| T35 | U/I/N | B imzası yok/yanlış, B yetersiz reserve, yanlış A kaydı | Reddet; A sorumluluğu atomik kalır; alıcıya ek ödeme/imza dayatılmaz |
| T36 | I | Aynı sponsorship için devir ve graduation aynı anda | Tek maintenance intent lock; biri tamamlanır, diğeri state'i yeniden okur |
| T37 | B/N | Gerçek Freighter, hiç fonlanmamış alıcı, davet linki | Connect sonrası bir işlem imzası; API alıcı private key almaz; zincir teyitli başarı ve video |
| T38 | B | Kullanıcı imzayı reddeder / eklenti yok / kilitli | Anlaşılır hata, güvenli yeniden dene; başarı gösterilmez, server imzası üretilmez |
| T39 | B/I | Prepare sonrası cüzdan hesabı/ağı değişir veya süre dolar | Eski işlem kabul edilmez; yeni prepare gerektiği gösterilir; cap/lease doğru temizlenir |
| T40 | B/I | Sayfa yenileme, bağlantı kopması, geciken onay | Request durumuna geri dönülür; CONFIRMED olmadan yeşil başarı yok |
| T41 | B | `/`, `/app`, `/onboard/:token`, `/docs` masaüstü/mobil | Tanıtım kökte; belirgin uygulamaya gir düğmesi; uygulama ayrı; belgeler erişilebilir |
| T42 | I/B | Geçersiz/iptal edilmiş token, tahmin edilmiş request id | Allowlist/adres detayları ifşa olmaz; unauthorized sonuç; sınırlı public status |
| T43 | I/B | Mevcut hesap / daha önce onboard olmuş veya kapanıp tekrar açılan adres | Duplicate işlem yok; uygun olmayan akış açık; consumed kaydı izin olmadan yeniden aktive olmaz |
| T44 | R/B/I | Browser/network/log/build/DB secret ve anahtar kontrolü | Alıcı seed/key yok; sponsor key frontend ve repoda yok; yalnız fixture code anahtar üretir |

## Release ve teslimat

| Test | Katman | Senaryo | Beklenen sonuç / kanıt |
|---|---|---|---|
| T45 | I/R | Testnet reset/epoch değişimi, eski hash sorgusunda yok sonucu | Eski başarılar yeni ağ hesabı gibi kullanılmaz; pause ve kurulum prosedürü; tarihli kanıt korunur |
| T46 | I/R | Worker kapalı, signer erişilemez, reserve monitor durmuş | Health bozuk; yeni imza güvenli biçimde engellenir; mevcut sponsorluk silinmez |
| T47 | R | Temiz klon, lockfile kurulum, unit+integration test, build | Kaynaklar Git'te; gerçek test komutu; MIT uyumlu paket metadata; docs ile tekrar üretim |
| T48 | R/B | Foreveranka release'inin Fatih deposu/siteye aktarımı | Kod ağacı ve release manifesti eş; API/worker/site smoke testi; public linkler doğru |
| T49 | R/I | Testnet-only config'e mainnet/custom URL/issuer enjekte et | Startup veya validation hatası; kullanıcı input'u ağ/issuer/fee payer seçemez |
| T50 | R | D1/D2/D3 kanıt manifesti ve kapsam incelemesi | Hash+önce/sonra+video+CI aynı release; out-of-scope payment/Soroban/custody özelliği yok; test durumu doğru |

## Kanıt paketi

Her koşu için `release_commit`, `tree_hash`, `network_passphrase`, `network_epoch`, `sdk_version`, `runtime_version`, `started_at`, `finished_at`, `test_ids`, `passed/failed/skipped` ve artifact checksum'ları kaydedilecek. `skipped` bir test başarı sayılmayacak. Başarısız beklenen işlem, beklenen result code assert edilmişse başarılı testtir.

| Teslimat | Sunulacak dosyalar | İnceleyen kişinin doğrulayacağı sonuç |
|---|---|---|
| D1 | onboarding fee-bump hash ve inner hash; account/TL/signers/sponsor before-after; assertion çıktıları; canonical mutation test raporu; concurrent10 manifesti | 0XLM alıcı, tek signer, doğru TL; ücret dışında para aktarımı yok; değiştirilen işlem reddi ve concurrency |
| D2 | Kısa ekran videosu; 50 adreslik anonim/test allowlist; havuz cap/pending/active ekranları; rejected adres ve auto-pause audit kaydı; live app/docs | Kurum ürünü işletiyor, listede olmayan giremiyor, limit ve izleme gerçek |
| D3 | Gerçek Freighter tek imza videosu; graduation ve handover hash'leri; A/B/alıcı snapshots; README/API/self-host/security/recovery docs; public release | Alıcı custody yok; rezerv çözülüyor/devrediliyor; başkası kurup kullanabiliyor |

Hazırlık fonlaması onboarding ücret hesabından ayrılacak. Fee payer ayrı hesapsa sponsorun reserve değişimi ve fee payer'ın cash değişimi ayrı, toplam kurum maliyeti birlikte gösterilecek. Graduation için alıcının test XLM edinmesi ayrı fixture işlemi olarak etiketlenecek; Cardea reserve release işlemi Payment olarak sunulmayacak.

Hash'ler ve explorer linkleri geçmişi sıfırlanabilen testnet'e aittir. Bu nedenle XDR/result/account snapshot ve video checksum'ları da korunacak. İmzalı test zarfı herkese açılacaksa önce ledger'a dahil olduğu veya kesin süresinin geçtiği doğrulanacak; bekleyen imzalı zarf public artifact olmayacak. Gerçek kişilere ait allowlist ve yönetim token'ları kanıt paketine girmeyecek.

## Teslimde başarı eşiği

R01–R36'nın her biri en az bir doğrulanabilir kanıta bağlanmış olmalı. Açık sponsor yetkisi, yanlış imza kabulü, replay, kota aşımı, yanlış muhasebe veya kullanıcı anahtar ifşası bulgusu varken release tamamlandı sayılmaz. Üç teslimatın hash/video/CI kanıtları aynı kod sürümüne ait olmalı. Bu kabul testnet ürününe aittir; mainnet'te finansal güvenlik garantisi değildir.
