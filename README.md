# kx-results
Results service for the Kayak Cross competitions
## How to install and use the software

1. Install *node* to your computer. This has been tested with Linux/Mint but 'should' work with Windows also.
2. Juts copy the software from here to your computer. *kx-server* archive has actual software.
3. Open the terminal software and go to the *kx-server* archive
4. Start the software with command `ǹode server.js`. This creates also an empty database for the competition - without rules (see installation step #7).
5. Open your web browser and enter `localhost:3000` as an address. Everything should look good now, but without any competition data.
6. Stop the software by pressing Crtl+C.
7. Upload pre-defined rules from rules archive `node scripts/upload-rules.js`.  

## How to upload athletes

See examples of files *KXM-6-athletes.csv* and *KXN-8-athletes.csv*. There are ready mady rule sets for 6 and 8 athletes, so it is fast to test with those files. 

**First row of the CSV file is for instructions and always skipped.**

Format: ```event;bib;first_name;last_name;club;country;icf_id;nf_id```
- *event* is the event code (e.g. KXM)
- *bib*; the bib can be text or number
- *club*; club name
- *country*; 3 letter country code (e.g. FIN)
- *icf_id*; (optional) this is ICF's ID for athletes, which is available in (Sports Data Platform)[https://www.canoeicf.com/sports-data-platform]
- *nf_id*; (optional) this is national ID for the athlete, e.g. Sportti ID in Finland. 
   
