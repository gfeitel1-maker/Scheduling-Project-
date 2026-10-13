// The owner's About text (T341), VERBATIM from the owner's document. Do not edit, trim or "fix" any of it:
// AboutScreen.test.jsx pins sentences from it. Generated line for line from the owner's plain-text source:
// line 1 is the title, line 2 the subtitle, six lines are section headings, the last two are the credit, and
// every other line is its own paragraph.

export const ABOUT_TITLE = "About Shoresh"

export const ABOUT_SUBTITLE = "An unnecessarily comprehensive explanation of a reasonably straightforward thing, including several observations about the future of software that seemed relevant at the time."

export const ABOUT_BLOCKS = [
  {
    "type": "p",
    "text": "Scheduling a summer camp is, when considered from a sufficiently generous distance, a relatively straightforward exercise in arranging people, places, and activities across a finite number of hours, which is a description that has the considerable advantage of being technically accurate while simultaneously communicating almost nothing about the experience of actually doing it, an experience familiar to anyone who has ever attempted to explain to a swimming instructor why seventeen children are arriving at the pool simultaneously despite the schedule, which everyone agreed was perfectly reasonable when they approved it, indicating quite clearly that the schedule was either less reasonable than everyone believed or that reasonableness itself becomes a somewhat flexible concept around the third week of June."
  },
  {
    "type": "p",
    "text": "This is a problem computers are particularly well suited to solving."
  },
  {
    "type": "p",
    "text": "Computers, after all, possess a remarkable capacity for remembering things, arranging things, comparing things, and informing us when two things are attempting to occupy the same place at the same time, which is a useful capability in practically every field of human endeavor and an especially useful capability in summer camp, where the two things in question are frequently groups of children who have been promised the same swimming pool."
  },
  {
    "type": "p",
    "text": "And so, naturally, we developed software."
  },
  {
    "type": "p",
    "text": "Lots of software."
  },
  {
    "type": "p",
    "text": "An extraordinary quantity of software, really, considering that the fundamental problem remains arranging people, places, and activities across a finite number of hours, although the software industry has developed an impressive vocabulary for describing this process in ways that suggest the underlying mathematics has undergone some sort of revolutionary transformation since the invention of the calendar."
  },
  {
    "type": "p",
    "text": "We have platforms. We have solutions. We have ecosystems. We have enterprise-grade, cloud-native, fully integrated operational management environments, which is a considerable collection of words to describe something that might ultimately tell you whether the gym is available at 10:30."
  },
  {
    "type": "p",
    "text": "And these things are genuinely impressive."
  },
  {
    "type": "p",
    "text": "The modern software industry has accomplished extraordinary things, including the ability to make information available almost anywhere, to connect people across continents, and to coordinate activities at scales that would have seemed preposterous a generation ago, all of which represent meaningful achievements in human ingenuity and several of which have made the experience of running a summer camp considerably more manageable."
  },
  {
    "type": "p",
    "text": "Somewhere along the way, however, we developed a rather specific understanding of how software ought to be delivered, an understanding in which the software lives on somebody else's computer, the information lives alongside it, and the person who actually needs to accomplish something pays a recurring fee for the opportunity to interact with both."
  },
  {
    "type": "p",
    "text": "This is an excellent arrangement for a great many purposes, including, one imagines, the continued financial well-being of the people collecting the recurring fees."
  },
  {
    "type": "p",
    "text": "It is also one arrangement among several."
  },
  {
    "type": "p",
    "text": "Which brings us, somewhat unexpectedly, to Shoresh."
  },
  {
    "type": "heading",
    "text": "A perfectly reasonable thing to build"
  },
  {
    "type": "p",
    "text": "Shoresh began with the observation that I needed to make a camp schedule, followed by the observation that the available methods of making a camp schedule presented a collection of compromises, followed by the increasingly interesting observation that many of those compromises had considerably more to do with the conventions of software development and distribution than with the actual requirements of making a camp schedule."
  },
  {
    "type": "p",
    "text": "This last observation proved particularly troublesome, principally because it invited the sort of questions that tend to consume one's evenings."
  },
  {
    "type": "p",
    "text": "For example, why should a schedule require a continuous internet connection when the people, activities, and locations being scheduled are all physically present at the same camp?"
  },
  {
    "type": "p",
    "text": "Why should the information describing those people, activities, and locations need to reside on a computer operated by an entirely different organization?"
  },
  {
    "type": "p",
    "text": "Why should two people sitting in the same building require the assistance of a third computer, potentially located several thousand miles away, to agree that the basketball court is occupied?"
  },
  {
    "type": "p",
    "text": "And why, having already established that computers are remarkably capable of remembering things and comparing things and arranging things, should the privilege of asking a computer to perform those activities necessarily involve an ongoing financial relationship with somebody who has never met the basketball specialist?"
  },
  {
    "type": "p",
    "text": "These are interesting questions."
  },
  {
    "type": "p",
    "text": "They become considerably more interesting when you begin attempting to answer them, because answering them leads rather quickly into discussions of databases, distributed systems, network protocols, synchronization, conflict resolution, and the philosophical implications of two computers possessing different but equally sincere beliefs about what is supposed to happen on Wednesday."
  },
  {
    "type": "p",
    "text": "Wednesday, incidentally, is frequently where these things go wrong."
  },
  {
    "type": "p",
    "text": "And so I built Shoresh."
  },
  {
    "type": "p",
    "text": "Or, more accurately, I began building Shoresh, which is an important distinction because building software turns out to involve a continuous series of discoveries about the difference between what one intended a computer to do and what one actually instructed it to do, a distinction that computers observe with a degree of literal-minded enthusiasm that would be admirable in almost any other circumstance."
  },
  {
    "type": "heading",
    "text": "A brief digression concerning artificial intelligence, which is actually rather central to the whole thing"
  },
  {
    "type": "p",
    "text": "I am a camp director."
  },
  {
    "type": "p",
    "text": "This is worth establishing because it explains both why I wanted to build scheduling software and why the fact that I built scheduling software is, in its own modest way, more interesting than the scheduling software itself."
  },
  {
    "type": "p",
    "text": "I know how summer camps operate."
  },
  {
    "type": "p",
    "text": "I know how schedules are constructed, how schedules are interpreted, how schedules are ignored, and how schedules occasionally achieve the remarkable feat of being simultaneously correct, approved, distributed, and entirely impossible to execute."
  },
  {
    "type": "p",
    "text": "I know that the distance between two activities matters, that the age of the children participating matters, that the particular staff members assigned to those children matter, and that a schedule which appears perfectly balanced when viewed as a collection of colored rectangles may produce a considerably different impression when viewed from the perspective of a counselor attempting to move fourteen six-year-olds across a field in ninety-degree weather."
  },
  {
    "type": "p",
    "text": "This is specialized knowledge."
  },
  {
    "type": "p",
    "text": "It is knowledge acquired through experience, through observation, through making decisions and watching their consequences, and through the gradual accumulation of thousands of small understandings that become so thoroughly integrated into one's thinking that explaining them individually can become a rather substantial undertaking in its own right."
  },
  {
    "type": "p",
    "text": "For most of the history of software development, possessing this knowledge and possessing the technical ability to translate it into functioning software were two quite separate things."
  },
  {
    "type": "p",
    "text": "A person who understood a problem could explain that problem to a person who understood computers, and the two could work together to produce a solution, an arrangement that has generated an extraordinary amount of useful software and an equally extraordinary number of meetings in which somebody explains, for the fourth time, that the schedule needs to accommodate different activities on different days."
  },
  {
    "type": "p",
    "text": "Artificial intelligence has introduced an interesting complication to this arrangement."
  },
  {
    "type": "p",
    "text": "A person who understands a problem can now work with an artificial intelligence system to construct the software that addresses it, which is a development of considerable significance because it changes the relationship between specialized knowledge and the means of expressing that knowledge in software."
  },
  {
    "type": "p",
    "text": "Which means that a person who has spent twenty years learning how to run a summer camp can now spend a considerably smaller number of years learning how to explain to a computer what running a summer camp actually involves, an arrangement that seems particularly advantageous when one considers that the computer has already demonstrated a remarkable capacity for writing software and a rather less remarkable capacity for understanding why the six-year-olds need an additional fifteen minutes to change after swimming."
  },
  {
    "type": "p",
    "text": "This process still requires thought, judgment, experimentation, patience, and a willingness to discover that an apparently minor adjustment to one portion of an application has produced a rather spectacular collection of unintended consequences elsewhere, but it also makes possible something that was previously inaccessible to a great many people."
  },
  {
    "type": "p",
    "text": "It makes software creation a practical extension of expertise."
  },
  {
    "type": "p",
    "text": "And that, I think, is worth considering for a moment."
  },
  {
    "type": "p",
    "text": "Because the expertise required to understand a problem has always been distributed throughout the world, residing in teachers, nurses, mechanics, farmers, librarians, camp directors, and approximately everyone else who has ever developed a sophisticated understanding of something they do regularly."
  },
  {
    "type": "p",
    "text": "The technical capacity to turn that expertise into software has historically been concentrated among a considerably smaller group of people."
  },
  {
    "type": "p",
    "text": "Artificial intelligence is changing that relationship."
  },
  {
    "type": "p",
    "text": "Which means that the next generation of specialized software may increasingly be created by the people who possess the specialized knowledge, rather than exclusively by the organizations that possess the specialized software developers."
  },
  {
    "type": "p",
    "text": "This is an exciting prospect for the people who possess the specialized knowledge."
  },
  {
    "type": "p",
    "text": "It may also introduce some interesting questions for the organizations that currently sell those people subscriptions."
  },
  {
    "type": "p",
    "text": "Although, to be fair, the organizations selling subscriptions have demonstrated considerable creativity in answering interesting questions, frequently by introducing additional subscription tiers."
  },
  {
    "type": "heading",
    "text": "Concerning ownership, which is a surprisingly complicated word for such a simple idea"
  },
  {
    "type": "p",
    "text": "Shoresh is built around a relatively straightforward principle."
  },
  {
    "type": "p",
    "text": "Your schedule belongs to you."
  },
  {
    "type": "p",
    "text": "This means the information you enter, the arrangements you create, the decisions you make, and the resulting collection of people, places, activities, and times remain under your control, which seems a perfectly ordinary expectation when applied to a notebook, a filing cabinet, or a piece of paper, and becomes strangely ambitious when applied to software."
  },
  {
    "type": "p",
    "text": "The application runs on your computer."
  },
  {
    "type": "p",
    "text": "The information can remain on your computer."
  },
  {
    "type": "p",
    "text": "The application can function without an internet connection, which is particularly useful at summer camps, where internet connectivity occasionally operates according to principles that appear to have been developed independently of conventional telecommunications engineering."
  },
  {
    "type": "p",
    "text": "When collaboration is useful, computers can communicate with one another."
  },
  {
    "type": "p",
    "text": "When information needs to move, it can move."
  },
  {
    "type": "p",
    "text": "When somebody wants to modify the application, the code is available for modification."
  },
  {
    "type": "p",
    "text": "These are architectural choices, and architectural choices have consequences, which is a rather elaborate way of saying that the way something is built determines what the people using it are able to do."
  },
  {
    "type": "p",
    "text": "A building designed with movable walls permits a different kind of use than a building designed with permanent partitions."
  },
  {
    "type": "p",
    "text": "A schedule designed around flexible activities permits a different kind of operation than a schedule designed around fixed assignments."
  },
  {
    "type": "p",
    "text": "And software designed around the assumption that its users possess their own information permits a different kind of relationship between the software and the people using it."
  },
  {
    "type": "p",
    "text": "In Shoresh, that relationship begins with ownership."
  },
  {
    "type": "p",
    "text": "The rest follows from there."
  },
  {
    "type": "p",
    "text": "There is a certain pleasure in building something this way, particularly when one considers that the underlying technologies are neither especially mysterious nor particularly new, and that the ability of computers to communicate directly with one another predates a considerable portion of the modern software industry."
  },
  {
    "type": "p",
    "text": "We have, in other words, arrived at a rather interesting moment in technological history in which some of the most compelling possibilities for the future of software involve remembering things computers were already capable of doing."
  },
  {
    "type": "p",
    "text": "Which seems appropriate."
  },
  {
    "type": "p",
    "text": "Summer camps have been making schedules for generations, and the fundamental principles of scheduling have remained remarkably consistent throughout that time, even as the technologies available to accomplish the task have evolved from pencil and paper to spreadsheets to specialized applications to whatever we decide to call the next generation of systems that will, presumably, still need to determine whether the gym is available at 10:30."
  },
  {
    "type": "heading",
    "text": "Concerning the business model, or the rather peculiar economics of giving something away"
  },
  {
    "type": "p",
    "text": "Shoresh is open-source."
  },
  {
    "type": "p",
    "text": "You can use it, examine it, modify it, and build upon it, subject to its license, which is an arrangement that reflects both the purpose of the application and the circumstances of its creation."
  },
  {
    "type": "p",
    "text": "I built Shoresh because I understood a problem and wanted a tool that addressed it."
  },
  {
    "type": "p",
    "text": "The process of building that tool became possible because an enormous collection of people, working across decades and continents, created programming languages, libraries, frameworks, protocols, documentation, and artificial intelligence systems that made the undertaking accessible to someone whose professional experience has involved considerably more sunscreen than software engineering."
  },
  {
    "type": "p",
    "text": "That is an extraordinary collective achievement."
  },
  {
    "type": "p",
    "text": "And it seems entirely reasonable that something built upon that achievement should contribute something back to it."
  },
  {
    "type": "p",
    "text": "If Shoresh works for your camp, use it."
  },
  {
    "type": "p",
    "text": "If your camp operates differently, change it."
  },
  {
    "type": "p",
    "text": "If you discover a better way to accomplish something, build it."
  },
  {
    "type": "p",
    "text": "If you create something useful in the process, consider sharing it, because the next person attempting to solve a similar problem may possess an entirely different collection of experiences and observations, and those experiences may reveal possibilities that neither of us considered."
  },
  {
    "type": "p",
    "text": "This is, among other things, how useful things become more useful."
  },
  {
    "type": "p",
    "text": "It also produces a rather appealing alternative to the assumption that every specialized operational need represents an opportunity to create another subscription service."
  },
  {
    "type": "p",
    "text": "Sometimes a useful thing can simply be a useful thing."
  },
  {
    "type": "p",
    "text": "This is, admittedly, a somewhat unconventional position in an industry that has developed considerable expertise in transforming useful things into services, services into platforms, platforms into ecosystems, and ecosystems into quarterly invoices, although one must admire the organizational discipline required to accomplish this while maintaining that the primary beneficiary of the arrangement is the person receiving the invoice."
  },
  {
    "type": "p",
    "text": "A concept that, while perhaps lacking the financial sophistication of a recurring revenue model, possesses a certain elegance."
  },
  {
    "type": "heading",
    "text": "The larger question, which has been lurking here for some time and has now become increasingly difficult to ignore"
  },
  {
    "type": "p",
    "text": "There is a broader implication to all of this, and since we have already devoted a considerable number of words to what is ostensibly the About section of a scheduling application, we may as well acknowledge it."
  },
  {
    "type": "p",
    "text": "For decades, the software industry has operated around a relatively stable relationship between the people who need software, the people who understand how to build software, and the organizations that coordinate the production and distribution of software."
  },
  {
    "type": "p",
    "text": "That relationship has produced extraordinary results."
  },
  {
    "type": "p",
    "text": "It has also shaped our assumptions about what software is, where it comes from, who gets to make it, how much it should cost, and what sort of ongoing relationship a person ought to maintain with the organization that provides it."
  },
  {
    "type": "p",
    "text": "Artificial intelligence is changing the economics of software creation."
  },
  {
    "type": "p",
    "text": "Local computing and distributed networking provide ways to organize software around the people using it."
  },
  {
    "type": "p",
    "text": "Open-source development allows those people to share, modify, and improve the resulting tools."
  },
  {
    "type": "p",
    "text": "And the combination of these developments suggests a future in which specialized software becomes increasingly personal, increasingly adaptable, and increasingly accessible to the people who possess the knowledge necessary to make it useful."
  },
  {
    "type": "p",
    "text": "Consider what that means."
  },
  {
    "type": "p",
    "text": "A camp director can build scheduling software."
  },
  {
    "type": "p",
    "text": "A teacher can build classroom management software."
  },
  {
    "type": "p",
    "text": "A mechanic can build a system for organizing repairs."
  },
  {
    "type": "p",
    "text": "A librarian can build something for organizing a library, which is admittedly a field with a substantial history of organizing things and therefore perhaps an unusually well-prepared audience for this particular technological development."
  },
  {
    "type": "p",
    "text": "Each of these people understands something about their work that would require considerable effort to communicate fully to somebody outside it."
  },
  {
    "type": "p",
    "text": "Each can increasingly translate that understanding into software."
  },
  {
    "type": "p",
    "text": "And each can share the result with other people who understand the same work, allowing the software to develop through the accumulated experience of the people who actually use it."
  },
  {
    "type": "p",
    "text": "This suggests a rather different relationship between expertise and technology."
  },
  {
    "type": "p",
    "text": "One in which the people closest to a problem possess an increasingly direct ability to create the tools that address it, in which software becomes more specialized while the economics of producing it become considerably less exclusive, and in which ownership, portability, and adaptability return to being ordinary expectations rather than distinguishing features, a development that seems sufficiently consequential to warrant serious consideration by people considerably more qualified to discuss the future of the software industry than a summer camp director who began this entire undertaking because he wanted to move the Blue Group to archery."
  },
  {
    "type": "p",
    "text": "And one in which the question of who gets to build software has a considerably more interesting answer than it did even a few years ago."
  },
  {
    "type": "p",
    "text": "I find this exciting."
  },
  {
    "type": "p",
    "text": "I also find it mildly amusing that my contribution to exploring these possibilities involves a scheduling application for summer camps, although there is something rather satisfying about the idea that significant technological changes can be examined through ordinary practical problems, particularly because ordinary practical problems have the useful characteristic of continuing to exist regardless of how enthusiastically people discuss the technological changes that might eventually solve them."
  },
  {
    "type": "p",
    "text": "Which brings us back to the schedule."
  },
  {
    "type": "heading",
    "text": "Anyway, about the schedule"
  },
  {
    "type": "p",
    "text": "Shoresh is a tool for organizing a summer camp."
  },
  {
    "type": "p",
    "text": "It lets you arrange groups, activities, staff, locations, and times in ways that reflect how your camp actually operates, with the flexibility to accommodate the particular collection of traditions, constraints, preferences, and organizational peculiarities that make your camp your camp."
  },
  {
    "type": "p",
    "text": "It is designed to give you control over your information, freedom in how you work, and the ability to collaborate without making that collaboration dependent upon a permanent relationship with a centralized service."
  },
  {
    "type": "p",
    "text": "It is also an experiment in what becomes possible when the people who understand problems acquire the means to build their own solutions."
  },
  {
    "type": "p",
    "text": "Both of these things can be true."
  },
  {
    "type": "p",
    "text": "A piece of software can be a practical tool and an expression of a broader philosophy about how technology ought to serve the people who use it, just as a summer camp can be a place where children spend their days playing games and swimming and making friends while simultaneously serving as an environment in which they develop independence, build relationships, and discover things about themselves that will remain important long after anyone remembers what they did on the third Tuesday of July."
  },
  {
    "type": "p",
    "text": "The practical purpose and the larger purpose can coexist."
  },
  {
    "type": "p",
    "text": "In fact, I suspect they usually do."
  },
  {
    "type": "p",
    "text": "And perhaps that is the most interesting thing about Shoresh, although declaring something the most interesting thing after spending this many words identifying other interesting things seems a little presumptuous, particularly when the reader has demonstrated considerable patience in following an argument that began with a swimming schedule and has now wandered through artificial intelligence, distributed computing, software economics, professional expertise, and the organizational history of summer camps."
  },
  {
    "type": "p",
    "text": "The interesting thing is that Shoresh exists."
  },
  {
    "type": "p",
    "text": "A camp director wanted to make a schedule."
  },
  {
    "type": "p",
    "text": "He understood what the schedule needed to do."
  },
  {
    "type": "p",
    "text": "He acquired the means to build the software that would do it."
  },
  {
    "type": "p",
    "text": "And now the software exists, available for other people to use, adapt, improve, or simply regard as a rather elaborate solution to a problem they have been successfully solving with Excel for twenty years."
  },
  {
    "type": "p",
    "text": "Which is perfectly reasonable."
  },
  {
    "type": "p",
    "text": "Excel is an extraordinary piece of software."
  },
  {
    "type": "p",
    "text": "So is Shoresh, at least in the considerably narrower sense that it does the particular things I wanted it to do, although I recognize that describing one's own work as extraordinary in the About section of that work raises certain questions about objectivity, questions that become somewhat easier to resolve when one remembers that the person writing this About section is also the person who built the application and therefore has already demonstrated a willingness to devote unreasonable amounts of time to matters of personal interest."
  },
  {
    "type": "p",
    "text": "In any event, the schedule still needs to get made."
  },
  {
    "type": "p",
    "text": "The children still need to get to swimming."
  },
  {
    "type": "p",
    "text": "The counselors still need lunch."
  },
  {
    "type": "p",
    "text": "And somebody, somewhere, is going to ask whether the Blue Group can switch archery with basketball on Thursday."
  },
  {
    "type": "p",
    "text": "They can."
  },
  {
    "type": "p",
    "text": "That's rather the point."
  },
  {
    "type": "p",
    "text": "Welcome to Shoresh."
  },
  {
    "type": "p",
    "text": "Now go make a schedule."
  }
]

export const ABOUT_CREDIT = [
  "Written by GPT-6, with considerable philosophical encouragement, editorial direction, and firsthand knowledge of the absurdities of summer camp scheduling supplied by the camp director who built the thing.",
  "The artificial intelligence would also like to acknowledge that it was asked to write an About section, produced a minor treatise on the future of software, and considers this a perfectly reasonable interpretation of the assignment."
]
