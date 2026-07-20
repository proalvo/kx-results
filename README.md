# kx-results
Results service for the Kayak Cross competitions

## Features

- Open Source software - no license fee
- Create a competition with events
- Upload athletes to the events from the CSV file
- Create your own progression system (with limitations of the software)
- Publish results in Internet in real-time (at website with *kx-web* installed, such as [wwcf.fi/kx-results](https://wwcf.fi/kx-results) 

## How to install and use the software

1. Install [node](https://[node](https://nodejs.org/)) to your computer. This has been tested with Linux/Mint but 'should' work with Windows also, maybe even with Apple.
2. Juts copy the software from here to your computer. *kx-server* archive has actual software.
3. Open the terminal software and go to the *kx-server* archive
4. Start the software with command `ǹode server.js`. Empty database for the competition is created also - without rules (see installation step #7).
5. Open your web browser and enter `http://localhost:3000` as an address. Everything should look good now, but without any competition data, and no rules.
6. Stop the software by pressing Crtl+C.
7. Upload pre-defined rules from rules archive `node scripts/upload-rules.js`.  

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

## Roadmap

- Publish results to the public website -  "kx-web" is a separate application to publish results.
- Events are listen in alphabetical order by code (e.g. KXM is 1st, KXN is 2nd). It could be something different also.

## Knows bugs or features that require improvement

- Improvement: At the moment bib shall be unique in the competition. It should be possible to have the same bib in multiple events.
