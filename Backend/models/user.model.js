const { default: mongoose } = require('mongoose');
const mongosse = require('mongoose');

const userSchema = new mongosse.Schema({
    

    username:{
        type:String,    
        required:true,
        unique:true['username already takekn'],
        trim:true,
        minlength:3,
    },  
    email:{
        type:String,
        required:true,
        unique:true,
        minlength:5,
    },
    password:{
        type:String,
        required:true,
        minlength:6,
    }
    


});
const adminSchema= new mongoose.Schema({
    role: {
  type: String,
  enum: ["user", "admin"],
  default: "user"
}

})

const admin=mongoose.model('admin',adminSchema);
const user = mongosse.model('user',userSchema);
module.exports = { user, admin };