# Cardea teknik araştırması

## Sonuç ve uygulanabilirlik

Onaylanan ürün, Stellar'ın mevcut klasik işlem operasyonlarıyla tasarlanabilir. Yeni bir Soroban sözleşmesine gerek yoktur. Zor bölüm dört operasyonu üretmekten çok, sponsorun hangi işlemi imzaladığını sınırlamak, aynı rezervi iki kez tahsis etmemek, ağ sonucu belirsizken yanlış tekrar yapmamak ve rezerv yaşam döngüsünü gerçek cüzdan üzerinden kanıtlamaktır. Bu nedenle öneri, kapsamı genişletmeden küçük bir TypeScript işlem motoru, kalıcı PostgreSQL muhasebesi, yönetim ekranı ve worker geliştirmektir.

14 Eylül 2026 itibarıyla araştırma ve tasarım temeli hazırdır; çalışan ürünün kabulü henüz verilmiş değildir. SOW'un dört haftalık çizelgesine karşı 30 Eylül'e 17 takvim günü vardır. İlk iki gün içinde gerçek cüzdanla tek imza akışı kanıtlanırsa takvim daha güvenilir olur. Bu kapı başarısızsa farklı bir ürün inşa etmek yerine önce cüzdan/SDK uyumsuzluğu giderilmelidir.

## Belge ile mevcut durum arasındaki fark

SOW, yeni hesabı ve USDC trustline'ını sıfır XLM ile açan işlem, organizasyon havuzları, izin listesi, harcama/rezerv sınırları, otomatik duraklatma, graduation, devir ve doğrulanabilir açık kaynak teslimatı istiyor. İmza motoru bütün işin yalnızca bir bölümüdür. Testnet hash, video ve test çıktıları aynı sürüme ait olmalıdır. Gereksinimlerin tam eşlemesi [ayrı listede](REQUIREMENTS.md) bulunuyor. Kaynak: sağlanan SOW §3, §4.1–4.2, haftalık plan ve §6.1.

| Yerel bileşen | Gözlenen durum | Teslimata etkisi |
|---|---|---|
| `/Users/mete/cardea/spike.js` | Dört operasyon + fee bump; sponsor/channel/alıcı keypair'lerini script üretip imzalıyor | Protokol prototipi; gerçek cüzdan UX kanıtı sayılmaz |
| `negative.js` | Beklenen başarısızlıklar deneniyor; beklenmeyen başarı bazı yollarda yalnız konsola yazılıyor | Test runner başarısızlıkta kesin nonzero dönmeli |
| `graduate.js`, `handover.js` | Rezerv çözme ve devir prototipleri | Assertion, kalıcı kayıt, yarış/restart testleri eksik |
| `package.json` | `test` komutu placeholder; SDK aralığı `^17.0.0`; paket lisansı ISC | Tekrarlanabilir test kurulumu ve MIT uyumu gerekli |
| `.gitignore` | `*.js`, `package.json`, `package-lock.json` hariç tutuluyor | Açık kaynak teslimatta gerçek motor kayboluyor |
| Git takibi | `.gitignore`, README, CONTRIBUTING, LICENSE | Yerel prototiplerin GitHub'da olduğu varsayılamaz |
| `/Users/mete/cardea-site` | Tanıtım ve statik docs; gerçek `/app` akışı yok | D2 ve alıcı demosu henüz yok |
| Site metinleri | Tüm zarfı byte-byte eşitleme, bazı henüz kanıtlanmamış cüzdan/özellik iddiaları | Metinler teknik doğruluk ve kanıt durumuna göre düzeltilmeli |

Bu inceleme scriptlerin bu oturumda zincirde başarıyla çalıştığı anlamına gelmez. Kaynaklar okundu; para/fonlama/işlem yapan eski scriptler araştırma için çalıştırılmadı. Mevcut `.js` dosyalarında eski `toXDR` kullanımı tespit edilmedi; SDK 17 uyumsuzluğu aşağıdaki araştırma deneyinde eski API örneği kullanıldığında görüldü. Bütün prototiplerin bozuk olduğu sonucu çıkarılmamalı.

## Ağ, varlık ve sürüm tabanı

Salt okunur [ölçüm kaydı](evidence/environment.json), 14 Eylül 2026 00:05:57 Türkiye saatinde testnet ledger **4.661.994**, protocol **28**, baz rezerv **5.000.000 stroop**, baz ücret **100 stroop** gösterdi. Bir XLM 10.000.000 stroop olarak ele alınır. Bunlar uygulamada sabit ve sonsuza kadar geçerli değerler sayılmayacak; ledger/config üzerinden izlenecek. Ölçüm kendi zamanının snapshot'ıdır.[^1]

Varlık, Circle'ın testnet listesinde yer alan klasik **USDC** ve **`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`** issuer'ıdır. Yalnız sembol eşleştirmek yanlış varlığı kabul eder. Bu G adresi issuer'dır, alıcı cüzdanı veya Soroban kontratı değildir. Trustline açılması otomatik USDC ödeme alınmış olduğu anlamına gelmez.[^2]

Kurulu SDK 17.0.0; registry ölçümünde 17.0.1, Freighter API 6.0.1 bulunuyor. Öneri SDK'yı 17.0.1'e ve desteklenen Node sürümünü en az 22.12.0 olacak şekilde tam sürüme sabitlemek, lock dosyasını takip etmek ve temiz ortamda doğrulamaktır. SDK17'nin `toXdr`/`fromXdr`, sınıf tabanlı XDR, `Uint8Array` dönüşleri eski örneklerle aynı değildir. Byte karşılaştırmada `.equals`, hash üretiminde kör `.toString('hex')` kullanımına güvenilmez. İstemci ve sunucu aynı seri hale getirme sözleşmesini test etmelidir. Bunlar resmi migration rehberi ve kurulu kaynakla doğrulanan uyumluluk noktalarıdır.[^3]

## Sponsorluk ve rezervin anlamı

SOW'un temel akışı aşağıdaki gibidir. İç işlem kaynağı sequence sağlayan channel hesabıdır; operasyon kaynakları açıkça yazılır.

| Sıra | Operasyon | Kaynak | Sabit sınır |
|---|---|---|---|
| 1 | BeginSponsoringFutureReserves | Sponsor | Yalnız kayıtlı alıcı |
| 2 | CreateAccount | Sponsor | Aynı alıcı, startingBalance `0` |
| 3 | ChangeTrust | Alıcı | Sabit USDC issuer, sunucunun belirlediği limit |
| 4 | EndSponsoringFutureReserves | Alıcı | Ek operasyon yok |

CAP-33 aynı işlem içinde sponsorluk ilişkisini kurmayı ve bitirmeyi mümkün kılar. Mevcut baz rezervde hesap iki, normal trustline bir rezerv birimi gerektirir: bir alıcı için üç birim, yani 1,5 XLM. Sponsorun kilitli rezervi artar; alıcının eline bu tutarda ödeme geçmez. Bir kişinin sponsorluğunu kaldırmak `num_sponsoring` sayacını üç azaltır; sayaç kişi sayısı değildir.[^4]

Hesabın protokol minimumu `baseReserve × (2 + subentry_count + num_sponsoring − num_sponsored)` biçiminde hesaplanır. Kullanılabilir native bakiye değerlendirmesinde ayrıca native selling liabilities ve ilgili ücret yükü dikkate alınır. Graduation sonrası hesap için, kaldırılacak sponsorlu birimler `num_sponsored` değerinden düşürülerek yeni minimum hesaplanmalıdır.[^4]

Ürün muhasebesi için öneri: stroop cinsinden tam sayı, alıcı başına ayrı hesap/TL kaydı ve ledger numarası tutmak. 50 yeni alıcının yalnız bu rezerv taahhüdü 75 XLM'dir; sponsor/channel hesaplarının kendi minimumları ve ağ ücretleri ayrıca gerekir. Bu hesap ücret teklifi veya bütçe garantisi değildir. Sponsorun mevcut subentry ve liabilities durumu da kullanılabilir bakiyeyi etkiler; sadece `native balance > 75` kontrolü yeterli sayılmayacak.

## Fee bump ve işlem imzası

CAP-15 dış zarfın ücretini ayrı bir hesabın karşılamasına olanak verir. Dört operasyonlu iç işlem dış zarfta ücret hesabı açısından beş operasyon birimi olur. Ölçülen 100 stroop tabanıyla teorik taban 500 stroop, yani 0,00005 XLM'dir; yoğunluk ve teklif politikası gerçek ücreti değiştirir. İç ücretin düşük olması fee-bump akışının parçası olabilir; yalnız SDK'nın işlem üretmesi ağın kabulünü kanıtlamaz.[^5]

Tasarım kararı: iç işlem fee'sini sıfır tutma seçeneğini ilk testnet/cüzdan kabul kapısında denemek. Hem cüzdan hem ağ kabul ederse dış zarf haricinde ücret tahsil yolu bırakılmamış olur. Reddedilirse alternatif iç ücret seçimi belgelenip aynı güvenlik testlerinden geçmeli. Dış fee üst sınırı ve günlük ücret bütçesi zorunludur. Başarısız fakat ağa dahil olmuş işlemlerin ücretleri de bütçeden düşer; yalnız başarılı hesapları saymak fee griefing'i önlemez.

Sunucu unsigned işlemi hazırlar, canonical imza payload'ını ve hash'ini saklar. Dönen zarf parse edilir; işlem tipi, ağ, gövde, süre, kaynak, sequence ve operasyonların hazırlanan kayıtla eşitliği aranır. Alıcının gerçek Ed25519 imzası ayrıca doğrulanır. Sponsor, istemcinin gönderdiği keyfi bir zarfı doğrudan imzalamaz: kayıtlı gövdeyi yükleyip doğrulanmış alıcı imzasıyla birleştirir. Sadece zarfın JSON özetini karşılaştırmak gizli alanları kaçırabilir; yalnız signature hint'e bakmak da kimlik doğrulamaz.

[Çevrimdışı deney](evidence/xdr-check.json) yedi kontrolü geçti: imza sonrası zarf farklı; payload aynı; hash aynı; alıcı imzası geçerli; trustline limit değişikliği eski imzayla geçersiz; yanlış ağda imza geçersiz; dört operasyon için dış fee 500 stroop. Deney geçici ve kaydedilmeyen anahtarlar kullandı; ağ çağrısı, fonlama ve kullanıcı cüzdanı yoktu. Bu sonuç birim araştırma kanıtıdır, güvenlik audit'i veya çalışan onboarding kanıtı değildir.

## Eşzamanlılık ve belirsiz işlem sonucu

Channel hesapları transaction sequence'ini operasyonu yapan sponsor hesabından ayırabilir. Aynı sponsor operasyonları farklı channel sequence'leriyle gönderilebilir; gerekli source imzaları yine sağlanır. Bu, SOW'un 10 eşzamanlı onboarding hedefi için uygun bir temel sağlar.[^6]

Önerilen uygulama kuralları:

- Başlangıçta 10 channel; her channel için en fazla bir sonuçlanmamış imzalı işlem. Kanal tahsisi PostgreSQL kilidiyle yapılır.
- İmza bekleyen request de havuz rezerv kotasında yer tutar. Kanal ve kota tahsisi aynı veri tabanı transaction'ında yapılır.
- Aynı ağ/alıcı için paralel aktif lifecycle kaydı unique constraint ile engellenir. Request id ve iç hash sabittir; fee bump yenilenirse dış hash ayrıca kaydedilir.
- HTTP timeout veya bağlantı kopması “işlem başarısız” sayılmaz. `UNKNOWN` durumunda aynı işlemin zincir sonucu araştırılır; hemen yeni hesap açma işlemi hazırlanmaz.
- Signed/submit-ready işlem bir kez servisten çıkabilecek hale geldikten sonra yalnız duvar saati doldu diye kanal/kota serbest bırakılmaz. Ledger zamanı, hash sonucu ve sequence birlikte uzlaştırılır.
- Restart, DB bağlantı hatası, yavaş Horizon ve tekrar eden worker mesajları aynı state machine'den geçer.

Bu kurallar protokolün otomatik sağladığı ürün davranışları değildir; uygulamanın geliştirilip test edilmesi gereken güvenlik tasarımıdır. Onboarding imza penceresi için başlangıç önerisi 180 saniyedir; gerçek Freighter deneyine göre ayarlanabilir. Testnet üzerinde saldırı yükü oluşturulmaz; yüksek hacimli stres yerel/mocked düzende, SOW'un 10 kişilik fonksiyon testi ölçülü biçimde testnet üzerinde yapılır.

## Graduation ve devir

Graduation yeni bir XLM ödemesi değildir: sponsorun rezerv yükümlülüğünün kaldırılmasıdır. Alıcı hesabı kendi yeni minimumunu karşılayabiliyorsa sponsor account/TL sponsorluklarını kaldırabilir. Alıcı henüz karşılayamıyorsa reserve kontrolü engel olur. Devirde yeni sponsor ilişkiye katılarak yükümlülüğü devralabilir; uygun mevcut/yeni sponsor yetkilendirmeleriyle alıcı imzası gerekmeyen yol vardır.[^7]

Önerilen worker, “alıcıda 1,5 XLM gördüm, mezun et” sabit kontrolü yapmayacak. O anki subentry, num_sponsored/num_sponsoring, native selling liabilities ve kaldırılacak Cardea kayıtlarına göre işlem sonrası kullanılabilir bakiyeyi hesaplayacak. İşlem gönderilmeden önce ledger durumu yeniden okunacak; arada değişirse güvenli başarısızlık kabul edilip sonraki taramada değerlendirilecek. Hesap ve USDC TL revocation aynı atomik bakım işleminde planlanacak.

Bir alıcı trustline'ı kapatırsa veya sponsorlu kayıtlar dışarıdan değişirse worker kalan girişleri ledger ile eşleştirecek. Bu olaylar anında saldırı sayılmayacak; doğrulanabilen dış kapanma ile açıklanamayan sapma ayrılacak. Muhasebe farkı açıklanamıyorsa yeni sponsorluk pause edilir. Üç birimin kaldırıldığı tek alıcı fixture'ında sayaç 3→0 olur; gerçek çok alıcılı havuzun her graduation sonrası sıfıra inmesi beklenmez.

Handover için sponsor B'nin yeterli rezervi ve açık yetkisi şarttır. Sponsor A tek başına rastgele bir B hesabına yükümlülük yazamaz. B ile A'nın farklı operatörlere ait olabileceği durum için dar kapsamlı, süreli bakım işlemine imza verme akışı tasarlanmalı; onboarding'in genel imza endpoint'i bu yetkiye sahip olmamalı. Otomatik graduation, sponsor altyapısının çalışmasına bağlıdır; sponsorların parasının belli tarihte kesin serbest kalacağı vaat edilmez.

## Cüzdan deneyimi ve anahtar modeli

Freighter API işlem XDR'ı ile network passphrase ve hedef adres alıp imzalı XDR döndürebilir. Bu API sözleşmesi, mevcut Freighter sürümünün hiç fonlanmamış adres için Cardea'nın tam işlemine izin verdiğini tek başına kanıtlamaz. İlk kapı gerçek eklentiyle connect → bir işlem imzası → zincir teyididir. Kullanıcı reddi, yanlış ağ, hesap değiştirme ve expired request ayrı durumlar olmalıdır.[^8]

Bu sürüm için Freighter birinci cüzdan olarak öneriliyor. Çok cüzdanlı kit eklemek zorunlu SOW maddesi değildir; LOBSTR/xBull uyumluluğu test edilmeden “destekleniyor” yazılmamalı. Mobil/WalletConnect desteği kritik yolun dışına alınabilir; tek çalışan cüzdanla vaat edilen akış kanıtlanır. İleride adapter eklenebilecek bir arayüz bırakılması yeterlidir.

Alıcı private key'i asla servis tarafından üretilmez, alınmaz veya loglanmaz. Sponsor ise otomatik co-sign gerektiğinden kendi kontrolündeki imzalama altyapısını işletir. Önerilen self-host modelinde anahtar sahibi kurumdur; servis bu anahtarı kullanabildiği için “sponsor anahtarı ele geçirilse bile fon harcanamaz” denemez. Standart sponsor key yetkisi yalnız reserve operasyonlarına kriptografik olarak daraltılmış değildir. Dar şablon, sınırlı bakiye, erişim kontrolü ve ayrı fee/channel rolleri uygulama katmanı korumalarıdır.

## Hazır araçlar ve farklılaşma

| Araç | Doğrulanabilen yetenek | Karar |
|---|---|---|
| Stellar TypeScript Wallet SDK | Sponsoring builder, sıfır bakiyeli hesap oluşturma ve fee-bump örnekleri; Apache-2.0 | “Açık kaynakta böyle primitive yok” denemez. Referans olarak kullan; doğrudan SDK ile daha dar Cardea motoru tercih et |
| `brunomlr/stellar-sponsorship-service` | Public README'de self-host reserve sponsorship API, sponsor hesapları ve doğrulama akışı | Yakın işlevli örnek var. README lisansı `Private — All rights reserved`; kaynak görünür olması yeniden kullanım izni değildir. Kod kopyalanmayacak |
| OpenZeppelin Relayer rehberi | Classic fee-bump/sponsored transaction akışı, fee politikaları ve sponsorluk operasyonları listesi | Olası transport/signer alternatifi; SOW'un allowlist, rezerv muhasebesi, graduation ve handover ürününü hazır sağladığı doğrulanmadı |

Kaynaklar araçların kendi dokümanlarıdır; güvenlik, audit veya tüm Cardea teslimatlarını yerine getirme sonucu çıkarılmadı.[^9][^10][^11]

Bu araştırma “tam eşdeğer hiçbir ürün yok” iddiasını ispatlamaz. Daha savunulabilir konumlandırma: **açık kaynak, izin listeli kurum havuzu, doğrulanmış tek imzalı onboarding, rezerv muhasebesi ve rezervin çözülme/devir yaşam döngüsünü testnet kanıtlarıyla birlikte sunmak**. SOW'un onaylı maliyeti yeniden tartışılmadan README/site metnindeki mutlak yenilik iddiaları daraltılabilir.

Raven geliştiriciye kaynak ve servis keşfi sağlayan araştırma aracı olarak kullanılacak. Kullanıcının hesabını açma kararını veren bir LLM veya runtime imzalayıcı olmayacak. İşlem üretimi ve doğrulaması deterministik kodla yürütülecek; Raven erişiminin kesilmesi uygulamanın onboarding yapmasını durdurmamalı.

## Yayın, operasyon ve kanıt sınırları

Vercel'deki mevcut site başlangıç tanıtımını karşılıyor; uygulamaya giriş düğmesi eklenecek. Backend ile worker'ı kalıcı süreç/veri tabanı olan self-host ortamda tutmak, sürekli reserve izlemeyi kısa ömürlü frontend isteğinden ayırır. Bu bir tasarım tercihidir; yeni ücretli altyapı satın alma kararı değildir. Mevcut VPS kaynakları uygulama aşamasında ölçülmeli; diğer çalışan sistemlere ayrılan kaynaklar bozulmamalıdır.

Testnet periyodik sıfırlanır; hesaplar ve işlem geçmişi kaybolabilir. Resmi ağ sayfası mevcut takvimde 16 Aralık 2026'yı listeliyor; teslim öncesi duyurular tekrar kontrol edilmeli. Explorer linki tek uzun vadeli kanıt olamaz: hash, XDR, ledger sonuçları, önce/sonra snapshots, video ve commit birlikte saklanmalı. Testnet'in yüksek erişilebilirlik garantisi olmadığı da planın bağımlılığıdır.[^12]

## Açık mühendislik kapıları

| Konu | Araştırma sonucu | Tamamlanma koşulu |
|---|---|---|
| Sıfır-XLM Freighter imzası | API ve protokol uygun temel; gerçek UX bu çalışma içinde denenmedi | 15 Eylül'e kadar gerçek cüzdan testi |
| İç fee 0 / SDK17 tam akış | Offline build/sign kontrolü geçti | Aynı sürümle wallet + testnet kabulü |
| 10 eşzamanlı onboarding | Channel modeli uygun | Kalıcı lease/kota sistemiyle 10 hash ve hatasız muhasebe |
| Devir ve graduation | Protokol yolu ve yerel prototipler var | Worker/API aracılığıyla yeni pozitif/negatif kanıt |
| Self-host çalışma | Önerilen mimari net | Kaynak, domain/TLS, signer dosya izolasyonu ve recovery testi |
| Nihai teslim | SOW maddeleri/test matrisi eşlendi | Her D paketi aynı doğrulanmış release'e bağlandı |

Bunlar yeni araştırma başlıkları değil, uygulama aşamasında geçilecek deneysel kabul kapılarıdır. Başarılı testler riski azaltır; “hiç hata/zarar olamaz” güvencesi vermez. Bu SOW mainnet için güvenlik onayı değildir.

## Kaynaklar

Bütün çevrimiçi kaynaklar 14 Eylül 2026'da kontrol edildi. Sağlanan SOW, “2026.08.24_Instawards SOW - Fatih Golcu's Project”: `Ekran Resmi 2026-09-13 23.57.54.png`, `23.58.05.png`, `23.58.10.png`, `23.58.16.png`, `23.58.22.png`, `23.58.32.png`, `23.58.38.png`, `23.58.44.png`, `23.58.49.png`; §3, §4.1–4.2, haftalık plan, §6.1. Özel belge ekran görüntüleridir; erişilebilir tam belge veya görülmeyen sayfalar varsayılmadı.

[^1]: Stellar Development Foundation, [Testnet Horizon](https://horizon-testnet.stellar.org) ve [son ledger sorgusu](https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1); tarihli veri [environment.json](evidence/environment.json).
[^2]: Circle, [USDC Contract Addresses — Testnet](https://developers.circle.com/stablecoins/usdc-contract-addresses).
[^3]: Stellar, [JS SDK Migration Guide](https://stellar.github.io/js-stellar-sdk/guides/00-migration/); npm [SDK registry](https://registry.npmjs.org/@stellar/stellar-sdk/latest), [Freighter API registry](https://registry.npmjs.org/@stellar/freighter-api/latest). Yerel bağımsız kontrol `node_modules/@stellar/stellar-sdk/lib/esm/base/transaction_base.js`, `transaction_builder.js` ve araştırma deneyidir.
[^4]: Stellar, [Sponsored Reserves](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves).
[^5]: Stellar, [Fee-bump Transactions](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions) ve [CAP-0015](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0015.md).
[^6]: Stellar, [Channel Accounts](https://developers.stellar.org/docs/build/guides/transactions/channel-accounts).
[^7]: Stellar Protocol, [CAP-0033 — Sponsored Reserves](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0033.md), revoke/transfer ve reserve kuralları.
[^8]: Freighter, [signTransaction](https://docs.freighter.app/docs/playground/signtransaction/) ve [Sign XDR](https://docs.freighter.app/docs/sign-xdr).
[^9]: Stellar, [Wallet SDK Stellar Network guide](https://developers.stellar.org/docs/build/apps/wallet/stellar) ve [TypeScript Wallet SDK repository](https://github.com/stellar/typescript-wallet-sdk).
[^10]: Bruno / repository maintainer, [stellar-sponsorship-service](https://github.com/brunomlr/stellar-sponsorship-service), [README](https://raw.githubusercontent.com/brunomlr/stellar-sponsorship-service/main/README.md), [documentation](https://raw.githubusercontent.com/brunomlr/stellar-sponsorship-service/main/docs/DOCUMENTATION.md). Lisans satırı yeniden kullanım kısıtına işaret eder; güncel tam lisans izin alınmadan varsayılmayacak.
[^11]: OpenZeppelin, [Relayer 1.4.x — Stellar Sponsored Transactions Guide](https://docs.openzeppelin.com/relayer/1.4.x/guides/stellar-sponsored-transactions-guide).
[^12]: Stellar, [Networks — Testnet/Futurenet resets and intended uses](https://developers.stellar.org/docs/networks), sayfada son güncelleme 21 Temmuz 2026.
