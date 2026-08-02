# Lähtölistojen haku starttiin.fi palvelusta

Lähtölistat on mahdollista hakea `kx-results`iin suoraan starttiin.fi palvelusta.

Tee seuraavasti:

## 1.Tee lähtölistat

Tee lähtölistat starttiin.fi:ssä.
  - Tee jokaiselle sarjalle oma lähtölista. Nimeä lähtölistat SMSL sääntöjen mukaisilla luokkkien nimillä (MX1, WX1, MX45, WX45 jne.).
  - Arvo lähtöjärjestys
  - Laita kilpailunumerot
  - Tee lähtölistasta julkinen

![Koodin lisääminen](https://github.com/proalvo/kx-results/blob/main/images/starttiin-startlist.png "Lähtölistan tekeminen")
    
## 2. Hae koodit 

Katso kilpailun *raceId* ja *API-avain* starttiin.fi:n valikon kohdasta API-AVAIN
  - *raceId* on palvelun linkissä oleva kryptinen merkkisarja: `https://www.starttiin.fi/edit-race/00e110bi3fb/starts`

## 3.Perusta kilpailusarjat 

Tee *kx-reusults*issa vastaavat sarjat kuin lähtölistassa
  - Laita **Code** kenttään lähtölistan mukaisesti MX1, WX1, jne.
    
![Koodin lisääminen](https://github.com/proalvo/kx-results/blob/main/images/starttiin-event-code.png "Sarjan perustaminen")


## 4. Lataa lähtölistat

Mene `kx-results`sissa kohtaan **3. Athletes**, ja valitse **Upload athletes** — *import start lists from starttiin.fi*
  - Syötä *raceId* ja *API-avain*, ja paina **UPLOAD**
  - Tarkasta lista ja paina **SAVE**
  - Nyt sinulla on kilpailijat ladattuna. Voit tarkastaa ne *Setup* sivulla.

![Koodin lisääminen](https://github.com/proalvo/kx-results/blob/main/images/starttiin-import.png "Lähtölistan lataaminen")
