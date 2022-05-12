from asyncore import write
from distutils.file_util import write_file
import glob, os, re

final =""

os.chdir(os.path.dirname(os.path.dirname(__file__)))
for file in glob.glob("*"):
    if not os.path.splitext(file)[1] and os.path.isfile(file):

        # Good to go on this file, set state vars
        print(file)
        lineNumber = 0

        with open(file, 'r', encoding='UTF-8') as curFile:
            for line in curFile:
                lineNumber+=1
                # Detect empty beginning line
                if lineNumber == 1 and line.strip() == False:
                    lineNumber = 0
                    break
                # Process header
                if lineNumber== 1:
                    print(line);
                    final+="\\beginsong{"+line.rstrip('\n')+"}\n"
                elif lineNumber == 2 and line.strip:
                    # TODO handle authors
                    print "ok"
                else:
                    final+=line+"\n"
            final+="\\endsong\n\n"

os.chdir(os.path.dirname(__file__))
f = open("autogenerated.tex", "w", encoding='UTF-8')
f.write(final)
f.close()
