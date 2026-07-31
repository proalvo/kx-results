# Lähtölistojen haku starttiin.fi palvelusta

Lähtölistat on mahdollista hakea kx-resultsiin suoraan startiin.fi palvelusta.

Tee seuaavasti:

## 1.Tee lähtölistat

Tee lähtölistat starttiin.fi:ssä.
  - Tee jokaiselle sarjalle oma lähtölista. Nimeä lähtölistat sääntöjen mukaisilla luokkkien nimillä (MX1, WX1, MX45, WX45 jne. SMSL koskicrossin sääntöjen kohta 5).
  - Arvo lähtöjärjestys
  - Laita kilpailunumerot
  - Tee lähtölistasta julkinen

![Koodin lisääminen](https://github.com/proalvo/kx-results/blob/main/images/starttiin-startlist.png "Lähtölistan tekeminen")
    
## 2. Hae koodit 

Katso kilpailun raceId ja API-avain startiin.fi:n valikon kohdasta API-AVAIN
  - raceId on palvelun linkissä oleva kryptinen merkkisarja: www.starttiin.fi/edit-race/`00e110bi3fb`/starts

## 3.Perusta kilpailusarjat 

Tee *kx-reusults*issa vastaavat sarjat kuin lähtölistassa
  - Laita *CODE* kenttään lähtölistan mukaisesti MX1, WX1, jne.
    
![Koodin lisääminen](https://github.com/proalvo/kx-results/blob/main/images/starttiin-event-code.png "Sarjan perustaminen")


## 4. Lataa lähtölistat

Mene kx-results*issa kohtaan **3 Athletes**, ja valitse **Upload athletes** — import start lists from starttiin.fi
  - Syötä raceId ja API-avain, ja paina **UPLOAD**
  - Tarkasta lista ja paina **SAVE**

![Koodin lisääminen](https://github.com/proalvo/kx-results/blob/main/images/starttiin-import.png "Lähtölistan lataaminen")
