# kx-results - Result service for Kayak Cross competitions 

KX-Results is a complete, self-hosted result service for Kayak Cross competitions — from national races to international events using ICF rules. 

The software runs locally on any Windows or Linux PC and serves every role on the field of play through the browser: the Chief of Scoring manages events and results on a PC, Gate Judges record penalties in real time from their mobile phones, and the Streaming Operator gets ready-made, transparent HTML graphics for the streaming software. Rule-based progression systems make KX-Results adapt automatically to any field size, while live updates judges, scoring, and broadcast graphics in sync — heat after heat. 

Start lists and results can be printed as PDF, and results sync easily to a public website for spectators.

***Fast water. Fast results.***

## Features

- Create unlimited competitions with unlimited events
- Automatic ranking and creation of next competition phase based on the progression system (that you create also by yourself).
- Upload athletes to the events from the CSV file
- Split time can be used in Time Trial
- Create your own progression system (with the limitations of  the software) or use [ready made rules](https://github.com/proalvo/kx-results/tree/main/kx-server/rules).
- Publish results in Internet in real-time (at website with *kx-web* installed, such as [wwcf.fi/kx-results](https://wwcf.fi/kx-results)
- Print result as PDF.
- Add header and footer to PDFs.
- Leaderboard for on site competition information 

## How to install and use the software

1. Install [node](https://nodejs.org/) to your computer. This has been tested with Linux/Mint but 'should' work with Windows also, maybe even with Apple.
2. Juts copy the software from here to your computer. *kx-server* archive has actual software.
3. Open the terminal software and go to the *kx-server* archive
4. Start the software with command `ǹode server.js` *). Empty database for the competition is created also - without rules (see installation step #7).
5. Open your web browser and enter `http://localhost:3000` as an address. Everything should look good now, but without any competition data, and no rules.
6. Stop the software by pressing Crtl+C.
7. Upload pre-defined rules from rules archive `node scripts/upload-rules.js`.  

*) You can give the database and port as command line parameters, e.g. `node server.js test.db 3001`. You cannot omit the database part if you want to use other database than default, which is *kx.db*.

## How to upload athletes

See examples of files *KXM-6-athletes.csv* and *KXN-8-athletes.csv*. There are ready mady rule sets for 6 and 8 athletes, so it is fast to test with those files. 

- You can upload all athletes to the different events with one file.
- You can upload athletes with multiple files e.g. early birds with one file and last minute parcipants with an other file.

**First row of the CSV file is for instructions and always skipped.**

Format: ```event;bib;first_name;last_name;club;country;icf_id;nf_id```
- *event* is the event code (e.g. KXM)
- *bib*; the bib can be text or number
- *club*; club name
- *country*; 3 letter country code (e.g. FIN)
- *icf_id*; (optional) this is ICF's ID for athlete, which is provided by [Sports Data Platform](https://www.canoeicf.com/sports-data-platform)
- *nf_id*; (optional) this is national ID for the athlete, e.g. Sportti ID in Finland. 

## Leaderboard

Leaderboard provides event status in one screen. Application provide a carusel to show all event one after another. Use 24" monitor or bigger and set the browser to full screen (If you are using the Chrome, press F11).

URL:
```
http://{ip-address}:{port}/leaderboard
or
http://{ip-address}:{port}/leaderboard?interval={time in seconds}
```
For example:
```
http://localhost:3000/leaderboard
```

You can use second computer to show the leaderboard, then use an IP address of the your computer where you are running kx-results. `ifconfig` (Linux) and `ipconfig` (Windows) commands can be used to find out the IP address of the kx-results computer.

## Integrations

kx-results has integration to [startiin.fi](https://startiin.fi) to import athletes. Starttiin.fi is system by [Finnish Rowing and Canoing Federation](https://melontajasoutuliitto.fi).

- [Instructions for starttiin.fi (in Finnish)](starttiin.md)

## Roadmap

- Events are listed in alphabetical order by code (e.g. KXM is 1st, KXN is 2nd). Results manager should set the order of the events.
- "white board" for athletes to see all results and progression system.
- print all results to one document - not they printed per each competition phase
- possible to time schedule of the competiion
- "review" state for faults in public views.
- export results to CSV file
- CAPITALISE surname
- first_name_initial should be without dot (.)
  

## Knows bugs or features that require improvement

- If an event is deleted, it is not deleted from the kx-web.


