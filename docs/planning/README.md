# Cardea teslimat planı

Cardea, kurumların izin verdikleri alıcıları Stellar testnet üzerinde **alıcıdan XLM istemeden, tek işlem imzasıyla** USDC almaya hazır hale getiren açık kaynaklı bir araç olacak. Hesap ve trustline rezervi sponsorda kilitlenecek; alıcı yeterli XLM edindiğinde çözülecek veya başka bir sponsora devredilebilecek. Başarı ölçütü bu akışların uygulama, güvenlik testleri ve zincir kayıtlarıyla birlikte gösterilmesidir.

Onaylanan kapsam üç teslimat ve **5.000 dolar**: işlem motoru/güvenlik 2.500 dolar, kurum/havuz yönetimi 1.500 dolar, alıcı deneyimi/rezerv yaşam döngüsü/dokümantasyon 1.000 dolar. Hedef **30 Eylül 2026**. 14 Eylül itibarıyla 17 takvim günü var; SOW'daki dört haftalık sıra bu tarihlere sıkıştırılmıştır. Bu takvim bir çalışma hedefidir; kabul kapıları geçmeden “tamamlandı” denmez.

## Dosyalar

| Dosya | İçerik |
|---|---|
| [Gereksinimler](REQUIREMENTS.md) | SOW'a bağlı 36 gereksinim; kapsam dışı işler; kabul kanıtları |
| [Teknik araştırma](RESEARCH.md) | Protokol, cüzdan/SDK, mevcut kod, alternatifler, sınırlar ve kaynaklar |
| [Uygulama planı](IMPLEMENTATION-PLAN.md) | Mimari, veri modeli, güvenlik kararları, 14–30 Eylül takvimi, yayın sırası |
| [Test ve teslimat matrisi](TEST-MATRIX.md) | 50 test senaryosu ve üç teslimat için kanıt paketi |
| [Ortam ölçümü](evidence/environment.json) | Okuma amaçlı testnet/SDK sürüm ve ücret-rezerv ölçümü |
| [Çevrimdışı kontrol](evidence/xdr-check.mjs) / [sonuç](evidence/xdr-check.json) | İşlem imzası, değiştirme ve yanlış ağ için 7 araştırma kontrolü |

## İlk sırada yapılacaklar

1. Kaynak kodunu ve paket/lock dosyalarını Git takibine almak; lisans ve SDK sürümünü tutarlı hale getirmek.
2. Gerçek Freighter testnet cüzdanıyla sıfır XLM + tek alıcı işlem imzası akışını kanıtlamak.
3. İmza doğrulama, kalıcı kanal yönetimi ve tekrar işlemeyi önleme mekanizmasını kurmak.
4. Havuz, izin listesi, limit, muhasebe ve otomatik duraklatmayı tamamlamak.
5. Rezerv çözme/devretme, saldırı senaryoları, demo ve teslimat kanıtlarını tamamlamak.

Geliştirme deposu **Foreveranka/cardea**; son doğrulanmış sürüm **glckfatih2018-prog/cardea** hesabına aktarılacak. Ana sayfa tanıtım olarak kalacak, uygulama ayrı `/app` adresinde olacak. Bu çalışma sırasında ürün kodu, canlı dağıtım ve hesap anahtarları değiştirilmedi.

## Şu an ne doğrulandı?

Belgedeki görünen bütün kapsam, bütçe, takvim ve kabul maddeleri çıkarıldı. Protokol kaynakları, Raven üzerinden bulunan alternatifler, yerel prototipler, site metinleri ve canlı testnet parametreleri incelendi. Çevrimdışı SDK kontrolü geçti. **Bu araştırma sırasında zincire işlem gönderilmedi; Freighter uçtan uca testi, 10 eşzamanlı onboarding ve rezerv yaşam döngüsü henüz teslimat kanıtı olarak yeniden doğrulanmadı.**

Yerelde prototipler var; API, kalıcı veri tabanı, yönetim uygulaması ve geçerli otomatik test komutu henüz yok. `.gitignore` JavaScript ile paket dosyalarını dışlıyor. Mevcut site bazı planlanan özellikleri çalışıyormuş gibi anlatıyor; bunlar kanıt durumuyla eşleştirilecek. Eski kök `PLAN.md` tarihsel not olarak korunacak; onaylanan SOW ile çatıştığında bu dosyalardaki kapsam esas alınacak.
